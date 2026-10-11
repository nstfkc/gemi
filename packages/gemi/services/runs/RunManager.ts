import { DatabaseManager } from "../../database/DatabaseManager";
import type { Application } from "../../foundation/Application";
import { withDefaults } from "../../support/withDefaults";
import type { ChangeFeedEvent } from "../change-feed/ChangeFeedDriver";
import { ChangeFeedManager, type ChangeFeedSubscription } from "../change-feed/ChangeFeedManager";
import type { ChangeFeedResponse, StreamOptions } from "../change-feed/stream";
import { type Duration, toMilliseconds } from "../queue/workflow/duration";
import { runsConfigDefaults, type RunsConfig } from "./config";
import { DatabaseRunStore } from "./DatabaseRunStore";
import {
  isFinalRunStatus,
  MemoryRunStore,
  OPEN_RUN_STATUSES,
  type RunError,
  type RunFilter,
  type RunProgress,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type RunUpdate,
} from "./RunStore";

/** The longest run id or kind, in characters (a `VARCHAR(191)` column). */
export const MAX_RUN_ID_LENGTH = 191;

/**
 * How often, in milliseconds, `wait` and `execute` re-read a run even when
 * nothing woke them: a safety net for a change whose publish was lost.
 */
const RECHECK_MS = 30_000;

/** What `Runs.create` takes. */
export type CreateRunOptions = {
  /** What kind of work it is: `"page-build"`. */
  kind: string;
  /** The run's id. Default: a new `run_…` id. */
  id?: string;
  /** What it works on, to find it again with `list`: `"site:42"`. */
  subject?: string | null;
  /** Who started it, as the app names them: `"user:7"`. */
  owner?: string | null;
  /** What the starter says about it, as JSON. Fixed once created. */
  meta?: unknown;
  /** How long it may take before it times out. Default: no deadline. */
  deadline?: Duration | null;
  /** Record it as `running` rather than `pending`. Default `false`. */
  start?: boolean;
};

/** What `Runs.wait` takes. */
export type WaitOptions = {
  /**
   * How long to wait. When it passes, `wait` resolves to the run as it is
   * then, which may still be open. Default: until the run ends.
   */
  timeout?: Duration;
  /** Rejects `wait` with the signal's reason when it aborts. */
  signal?: AbortSignal;
};

/** What `Runs.execute` hands its function. */
export type RunHandle<P = unknown> = {
  readonly id: string;
  /** The run as `execute` found it, once started. */
  readonly record: RunRecord<unknown, P>;
  /**
   * Aborts when the run ends while the function is still working: it was
   * cancelled, or it passed its deadline. Hand it to whatever can stop early.
   */
  readonly signal: AbortSignal;
  /** Reports progress. Does nothing once the run has ended. */
  progress(progress: RunProgress<P>): Promise<void>;
};

/** No run has this id. */
export class RunNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`No run has the id ${id}.`);
    this.name = "RunNotFoundError";
  }
}

/**
 * Throw it from `Runs.execute`'s function to fail the run with this message
 * and code. They go on the record as they are, and the record is streamed to
 * whoever follows the run, so say only what a user may read. Any other error
 * fails the run with a generic message, and is logged.
 */
export class RunFailure extends Error {
  readonly code: string | undefined;
  readonly data: unknown;

  constructor(message: string, options: { code?: string; data?: unknown; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RunFailure";
    this.code = options.code;
    this.data = options.data;
  }
}

/**
 * Tracked background runs (#908): a record with a status machine, written by
 * whoever does the work and read, waited on or streamed by whoever needs the
 * outcome. Every change is published to the run's ChangeFeed channel, so a
 * waiter is woken, on any instance sharing the feed, instead of polling.
 *
 * ```ts
 * const run = await Runs.create({ kind: "page-build", subject: `site:${id}`, deadline: "10m" });
 * await PageBuildJob.dispatch({ runId: run.id });
 *
 * // In the job:
 * await Runs.execute(runId, async (run) => {
 *   await run.progress({ fraction: 0.5, message: "Writing copy" });
 *   return { pageId };
 * });
 *
 * // Anywhere:
 * const done = await Runs.wait(run.id, { timeout: "2m" });
 * ```
 */
export class RunManager {
  static token = "runs";

  readonly store: RunStore;
  readonly config: Required<RunsConfig>;
  private ownFeed: ChangeFeedManager | null = null;

  constructor(
    config: RunsConfig = {},
    private readonly options: { application?: Application; feed?: ChangeFeedManager } = {},
  ) {
    this.config = withDefaults(runsConfigDefaults(), config);
    this.store = resolveStore(this.config.store, options.application);
  }

  /** The change feed runs are published to: the app's, or one of its own without an app. */
  get feed(): ChangeFeedManager {
    if (this.options.feed) return this.options.feed;
    if (this.options.application) return this.options.application.make(ChangeFeedManager);
    this.ownFeed ??= new ChangeFeedManager();
    return this.ownFeed;
  }

  /** The ChangeFeed channel a run's changes are published to. */
  channel(id: string): string {
    return `gemi:run:${id}`;
  }

  /** Records a new run, `pending` unless `start` says otherwise. */
  async create<R = unknown, P = unknown>(options: CreateRunOptions): Promise<RunRecord<R, P>> {
    assertName("kind", options.kind);
    const id = options.id ?? `run_${crypto.randomUUID().replaceAll("-", "")}`;
    assertName("id", id);
    const record = await this.store.create({
      id,
      kind: options.kind,
      subject: options.subject ?? null,
      owner: options.owner ?? null,
      meta: options.meta ?? null,
      status: options.start ? "running" : "pending",
      deadlineMs:
        options.deadline === undefined || options.deadline === null
          ? null
          : toMilliseconds(options.deadline),
    });
    await this.publish(record);
    return record as RunRecord<R, P>;
  }

  /** The run, or `null`. */
  async get<R = unknown, P = unknown>(id: string): Promise<RunRecord<R, P> | null> {
    return (await this.store.get(id)) as RunRecord<R, P> | null;
  }

  /** Runs matching `filter`, newest first; at most `filter.limit` (default 50). */
  list(filter: RunFilter = {}): Promise<RunRecord[]> {
    return this.store.list(filter);
  }

  /** `pending` → `running`. Resolves to the run, or `null` when it was not pending. */
  start(id: string): Promise<RunRecord | null> {
    return this.change(id, ["pending"], { status: "running" });
  }

  /**
   * Replaces the run's progress, and starts it if it was pending. Resolves to
   * the run, or `null` when it has ended (or does not exist).
   */
  async progress<P = unknown>(id: string, progress: RunProgress<P>): Promise<RunRecord | null> {
    assertProgress(progress);
    return this.change(id, OPEN_RUN_STATUSES, { status: "running", progress });
  }

  /** Ends the run as `completed` with `result`. `null` when it had ended already. */
  complete(id: string, result?: unknown): Promise<RunRecord | null> {
    return this.change(id, OPEN_RUN_STATUSES, {
      status: "completed",
      result: result === undefined ? null : result,
    });
  }

  /**
   * Ends the run as `failed`. A string or a `RunError` is recorded as it is,
   * an `Error` by its message. The record is streamed to whoever follows the
   * run, so pass only what a user may read. `null` when it had ended already.
   */
  fail(id: string, error: string | RunError | Error): Promise<RunRecord | null> {
    return this.change(id, OPEN_RUN_STATUSES, { status: "failed", error: toRunError(error) });
  }

  /**
   * Ends the run as `cancelled`. A `Runs.execute` working on it sees its
   * `signal` abort. `null` when it had ended already.
   */
  cancel(id: string, reason?: string): Promise<RunRecord | null> {
    return this.change(id, OPEN_RUN_STATUSES, {
      status: "cancelled",
      error: { message: reason ?? "The run was cancelled.", code: "cancelled" },
    });
  }

  /**
   * Runs `fn` as the work of run `id`: starts the run, settles it from what
   * `fn` returns or throws, and aborts `run.signal` when the run is
   * cancelled or passes its deadline meanwhile. Resolves to the run as it
   * ended. It does not rethrow: a thrown `RunFailure` fails the run with its
   * message, any other error fails it with a generic one and is logged.
   *
   * A run that had already ended (cancelled before the job got to it) is
   * resolved as it is, without calling `fn`. A run that is already
   * `running` (a retry of a job that died) is taken up again.
   */
  async execute<R, P = unknown>(
    id: string,
    fn: (run: RunHandle<P>) => Promise<R> | R,
  ): Promise<RunRecord<R, P>> {
    const subscription = this.feed.subscribe(this.channel(id));
    try {
      await subscription.ready();
      const record = (await this.start(id)) ?? (await this.store.get(id));
      if (!record) throw new RunNotFoundError(id);
      if (isFinalRunStatus(record.status)) return record as RunRecord<R, P>;

      const controller = new AbortController();
      const watching = this.watch(id, record, subscription, controller);
      const handle: RunHandle<P> = {
        id,
        record: record as RunRecord<unknown, P>,
        signal: controller.signal,
        progress: async (progress) => {
          if (controller.signal.aborted) return;
          await this.progress(id, progress);
        },
      };
      let settled: RunRecord | null;
      try {
        const result = await fn(handle);
        settled = await this.complete(id, result);
      } catch (error) {
        if (!(error instanceof RunFailure) && !controller.signal.aborted) {
          console.error(`[gemi] Run ${id} failed.`, error);
        }
        settled = await this.change(id, OPEN_RUN_STATUSES, {
          status: "failed",
          error:
            error instanceof RunFailure
              ? toRunError(error)
              : { message: "The run failed.", code: "error" },
        });
      } finally {
        controller.abort();
        subscription.close();
        await watching;
      }
      return ((settled ?? (await this.store.get(id))) ?? record) as RunRecord<R, P>;
    } finally {
      subscription.close();
    }
  }

  /**
   * Resolves once run `id` has ended, to the run as it ended. With
   * `timeout`, resolves when it passes to the run as it is then, which may
   * still be open. A run past its deadline is timed out here, so a waiter
   * never hangs on a worker that died. Rejects with `RunNotFoundError` for
   * an unknown run.
   */
  async wait<R = unknown, P = unknown>(
    id: string,
    options: WaitOptions = {},
  ): Promise<RunRecord<R, P>> {
    const { signal } = options;
    signal?.throwIfAborted();
    const timeoutAt =
      options.timeout === undefined ? Infinity : Date.now() + toMilliseconds(options.timeout);
    const subscription = this.feed.subscribe(this.channel(id), { signal });
    try {
      await subscription.ready();
      let record = await this.store.get(id);
      if (!record) throw new RunNotFoundError(id);
      let next: Promise<unknown> | null = null;
      for (;;) {
        if (isFinalRunStatus(record.status)) return record as RunRecord<R, P>;
        signal?.throwIfAborted();
        const untilDeadline = await this.untilDeadline(record);
        if (untilDeadline !== null && untilDeadline <= 0) {
          record = (await this.expire(id)) ?? (await this.store.get(id)) ?? record;
          continue;
        }
        const remaining = timeoutAt - Date.now();
        if (remaining <= 0) return record as RunRecord<R, P>;
        // A feed that shut down leaves the timers: no busy loop on `done`.
        next ??= subscription.isClosed ? new Promise(() => {}) : subscription.next();
        const woke = await sleepOr(
          next,
          Math.min(remaining, untilDeadline ?? Infinity, RECHECK_MS),
          signal,
        );
        if (woke) next = null;
        record = (await this.store.get(id)) ?? record;
      }
    } finally {
      subscription.close();
    }
  }

  /**
   * Follows run `id`: yields the run as it is now, then each newer version
   * of it, and ends after the one that ended it. Iterate it with
   * `for await`; breaking out or `options.signal` ends it.
   */
  async *subscribe<R = unknown, P = unknown>(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<RunRecord<R, P>, void, undefined> {
    const subscription = this.feed.subscribe(this.channel(id), { signal: options.signal });
    try {
      await subscription.ready();
      let record = await this.store.get(id);
      if (!record) throw new RunNotFoundError(id);
      yield record as RunRecord<R, P>;
      if (isFinalRunStatus(record.status)) return;
      for await (const event of subscription) {
        const next = eventRecord(event, id) ?? (await this.store.get(id));
        if (!next || next.version <= record.version) continue;
        record = next;
        yield record as RunRecord<R, P>;
        if (isFinalRunStatus(record.status)) return;
      }
    } finally {
      subscription.close();
    }
  }

  /**
   * An SSE response following run `id`: each event's `data` is the run as
   * it was published (`RunRecord`), for a route that has already decided the
   * caller may read it. Resumes from `Last-Event-ID`, or `options.cursor`
   * (`Runs.cursor(id)`, read when the page read the run).
   */
  stream(
    request: { rawRequest: Request } | Request,
    id: string,
    options: StreamOptions = {},
  ): ChangeFeedResponse<RunRecord> {
    return this.feed.stream<RunRecord>(request, this.channel(id), options);
  }

  /** A cursor at the run's channel head, for a page that read the run to hand its client. */
  cursor(id: string): Promise<string> {
    return this.feed.cursor(this.channel(id));
  }

  /**
   * Times out open runs past their deadline, at most `sweepLimit` of them,
   * and resolves to how many. Schedule it, every minute say, so a run whose
   * worker died ends even when nobody waits for it.
   */
  async sweep(): Promise<number> {
    const now = await this.now();
    let count = 0;
    for (const record of await this.store.overdue(now, this.config.sweepLimit)) {
      if (await this.expire(record.id)) count++;
    }
    return count;
  }

  /**
   * Deletes runs that ended more than `olderThan` ago, and resolves to how
   * many. Open runs are never pruned. Resolves to `0` for a store without
   * `prune`.
   */
  async prune(olderThan: Duration): Promise<number> {
    const ms = toMilliseconds(olderThan);
    return (await this.store.prune?.(ms)) ?? 0;
  }

  /** Ends the own feed, when it made one. For tests. */
  async close(): Promise<void> {
    await this.ownFeed?.close();
    this.ownFeed = null;
  }

  private now(): Promise<number> {
    return this.store.now ? this.store.now() : Promise.resolve(Date.now());
  }

  /** Milliseconds until the run's deadline, on the store's clock, or `null`. */
  private async untilDeadline(record: RunRecord): Promise<number | null> {
    if (record.deadlineAt === null) return null;
    return record.deadlineAt - (await this.now());
  }

  /** Times the run out if it is open and past its deadline. */
  private async expire(id: string): Promise<RunRecord | null> {
    const record = await this.store.get(id);
    if (!record || isFinalRunStatus(record.status)) return null;
    const until = await this.untilDeadline(record);
    if (until === null || until > 0) return null;
    return this.change(id, OPEN_RUN_STATUSES, {
      status: "timed_out",
      error: { message: "The run passed its deadline.", code: "deadline" },
    });
  }

  /**
   * Aborts `controller` once the run ends, from the feed or its deadline,
   * and settles when `controller` aborts for any reason.
   */
  private async watch(
    id: string,
    record: RunRecord,
    subscription: ChangeFeedSubscription,
    controller: AbortController,
  ): Promise<void> {
    const ended = new Promise<"ended">((resolve) => {
      if (controller.signal.aborted) resolve("ended");
      controller.signal.addEventListener("abort", () => resolve("ended"), { once: true });
    });
    let next: Promise<unknown> | null = null;
    try {
      for (;;) {
        if (controller.signal.aborted) return;
        if (isFinalRunStatus(record.status)) {
          controller.abort();
          return;
        }
        const untilDeadline = await this.untilDeadline(record);
        if (untilDeadline !== null && untilDeadline <= 0) {
          record = (await this.expire(id)) ?? (await this.store.get(id)) ?? record;
          continue;
        }
        next ??= subscription.next();
        const woke = await Promise.race([
          ended,
          sleepOr(next, Math.min(untilDeadline ?? Infinity, RECHECK_MS)),
        ]);
        if (woke === "ended") return;
        if (woke) next = null;
        record = (await this.store.get(id)) ?? record;
      }
    } catch (error) {
      console.error(`[gemi] Run ${id}: could not follow the run for a cancel.`, error);
    }
  }

  private async change(
    id: string,
    from: readonly RunStatus[],
    to: RunUpdate,
  ): Promise<RunRecord | null> {
    const record = await this.store.transition(id, from, to);
    if (record) await this.publish(record);
    return record;
  }

  /**
   * Publishes the run to its channel. The store is the truth, so a publish
   * that fails is logged rather than thrown: waiters re-read the run every
   * 30 seconds whatever they hear.
   */
  private async publish(record: RunRecord): Promise<void> {
    try {
      await this.feed.publish(this.channel(record.id), record);
    } catch (error) {
      console.error(`[gemi] Run ${record.id}: could not publish its change.`, error);
    }
  }
}

/**
 * Resolves `true` when `next` settles first, `false` after `ms`, and rejects
 * when `signal` aborts.
 */
function sleepOr(next: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = Number.isFinite(ms) ? setTimeout(() => done(false), Math.max(0, ms)) : null;
    const onAbort = () => {
      cleanup();
      reject(signal!.reason);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const done = (value: boolean) => {
      cleanup();
      resolve(value);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    next.then(
      () => done(true),
      () => done(true),
    );
  });
}

/** The run an event carries, when it is a change of run `id`. */
function eventRecord(event: ChangeFeedEvent, id: string): RunRecord | null {
  if (event.type !== "change") return null;
  const data = event.data as Partial<RunRecord> | null;
  if (!data || typeof data !== "object" || data.id !== id || typeof data.version !== "number") {
    return null;
  }
  return data as RunRecord;
}

function toRunError(error: string | RunError | Error): RunError {
  if (typeof error === "string") return { message: error };
  if (error instanceof RunFailure) {
    return {
      message: error.message,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  if (error instanceof Error) return { message: error.message };
  return error;
}

function assertName(what: "id" | "kind", value: unknown) {
  if (typeof value !== "string" || value === "" || value.length > MAX_RUN_ID_LENGTH) {
    throw new TypeError(
      `A run's ${what} is a string of 1 to ${MAX_RUN_ID_LENGTH} characters; got ${JSON.stringify(value)}.`,
    );
  }
}

function assertProgress(progress: RunProgress<unknown>) {
  const { fraction } = progress;
  if (fraction !== undefined && !(Number.isFinite(fraction) && fraction >= 0 && fraction <= 1)) {
    throw new RangeError(`A run's progress fraction is between 0 and 1; got ${fraction}.`);
  }
}

function resolveStore(
  store: Required<RunsConfig>["store"],
  application: Application | undefined,
): RunStore {
  if (store === "memory") return new MemoryRunStore();
  if (store === "database" || typeof store === "function") {
    if (!application && (store === "database" || store.length > 0)) {
      throw new Error(
        "The runs store needs the application it belongs to, and this RunManager " +
          "was built without one. Pass { application }.",
      );
    }
    if (store === "database") {
      const connection = application!.make(DatabaseManager).connection();
      return new DatabaseRunStore(connection);
    }
    return store(application!);
  }
  if (typeof store === "string") {
    throw new Error(
      `Unknown runs store "${store}". The runs slice's store is "memory", ` +
        `"database", a RunStore, or a function returning one.`,
    );
  }
  return store;
}
