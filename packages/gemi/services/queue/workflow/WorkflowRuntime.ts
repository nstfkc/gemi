import { afterCommit, deferUntilCommit } from "../../../orm/context";
import type { ChangeFeedEvent } from "../../change-feed/ChangeFeedDriver";
import { ChangeFeedManager } from "../../change-feed/ChangeFeedManager";
import type { ChangeFeedResponse, StreamOptions } from "../../change-feed/stream";
import { Job } from "../Job";
import type { QueueManager } from "../QueueManager";
import {
  type EachProblem,
  Step,
  WorkflowSuspended,
  decode,
  describe,
  eachProgressOf,
  encode,
  problemOf,
} from "./Step";
import type { WorkflowClass, WorkflowStatus } from "./Workflow";
import { type WorkflowUpdate, workflowEnded } from "./wire";
import {
  WORKFLOW_TICK_JOB,
  type WorkflowChange,
  WorkflowLeaseLostError,
  type WorkflowRecord,
  type WorkflowRunStatus,
  type WorkflowStore,
} from "./WorkflowStore";

const ENDED: readonly WorkflowRunStatus[] = ["completed", "failed", "cancelled"];

/** How often a running `step.run` checks whether its workflow was cancelled. */
const CANCEL_CHECK_MS = 1000;

/** The least time between two publishes of one workflow's channel. */
const PUBLISH_INTERVAL_MS = 250;

/**
 * How often `subscribe` re-reads the workflow whatever it hears: a safety net
 * for a publish that was lost.
 */
const RECHECK_MS = 30_000;

type Outcome =
  | { kind: "completed"; result: string | null }
  | { kind: "failed"; error: string }
  | { kind: "suspended" };

/**
 * The queue's half of workflows: the registry of workflow classes, what
 * `Workflow.start`, `signal`, `find` and `cancel` do, and the tick.
 *
 * ### The tick
 *
 * A workflow advances only inside its tick job, which takes the workflow
 * from the store for a lease (the queue's `visibilityTimeout`, renewed while
 * it runs), runs one pass of `run`, and lets go with the outcome written in
 * the same step. Every write of the pass is fenced by that hold, so a tick
 * that lost it (it was too slow and another took over) changes nothing.
 *
 * A tick that finds the workflow held by another is dropped, after marking
 * the workflow so the holder enqueues a fresh tick when it lets go: a signal
 * that lands mid-pass is never lost, and two passes of one workflow never
 * overlap. A tick that failed or died holds the workflow under its job's id,
 * so its own retry takes it straight back.
 */
export class WorkflowRuntime {
  private registry: Record<string, WorkflowClass> = {};
  private storeInstance: WorkflowStore | undefined;
  private ownFeed: ChangeFeedManager | undefined;
  /** Workflows with a publish scheduled, and when each was last published. */
  private readonly publishing = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly published = new Map<string, number>();
  private tickClass: (new () => Job) | undefined;
  private readonly reportedNames = new Set<string>();

  constructor(private readonly queue: QueueManager) {}

  /** The workflow classes this process can run, by `static name`. */
  get workflows(): Readonly<Record<string, WorkflowClass>> {
    return this.registry;
  }

  /** Replaces the registry. The first class to claim a name wins. */
  use(workflows: readonly WorkflowClass[]) {
    this.registry = {};
    for (const workflow of workflows) {
      if (workflow.name === "unset" || !workflow.name) {
        console.error(
          `A workflow class has no \`static name\`, so it was not registered. Add one.`,
        );
        continue;
      }
      if (this.registry[workflow.name]) {
        console.error(
          `Two workflows are named "${workflow.name}" — the first is registered ` +
            `and this one is not. A workflow's name is its key in storage. Rename one.`,
        );
        continue;
      }
      this.registry[workflow.name] = workflow;
    }
  }

  /** The internal job a workflow's passes run in, one class per manager. */
  get tickJob(): new () => Job {
    this.tickClass ??= tickJobFor(this);
    return this.tickClass;
  }

  get store(): WorkflowStore {
    if (!this.storeInstance) {
      const store = this.queue.driver.workflowStore?.();
      if (!store || !this.queue.driver.enqueueBatch) {
        throw new Error(
          `This queue's driver does not support workflows. The memory and ` +
            `database drivers do.`,
        );
      }
      this.storeInstance = this.publishingStore(store);
    }
    return this.storeInstance;
  }

  /**
   * The change feed workflow changes are published to: the application's,
   * or one of this runtime's own (in memory) without one.
   */
  get feed(): ChangeFeedManager {
    const application = this.queue.boundApplication;
    if (application?.bound(ChangeFeedManager)) return application.make(ChangeFeedManager);
    this.ownFeed ??= new ChangeFeedManager();
    return this.ownFeed;
  }

  /** The ChangeFeed channel a workflow's changes are published to. */
  channel(id: string): string {
    return `gemi:workflow:${id}`;
  }

  /** What a change publishes: the status without `args` and `result`. */
  async update(id: string): Promise<WorkflowUpdate | null> {
    const status = await this.find(id);
    if (!status) return null;
    const { args: _args, result: _result, ...update } = status;
    return update;
  }

  /**
   * An SSE response following workflow `id`: each event's `data` is a
   * `WorkflowUpdate`, for a route that has already decided the caller may
   * read it.
   */
  stream(
    request: { rawRequest: Request } | Request,
    id: string,
    options: StreamOptions = {},
  ): ChangeFeedResponse<WorkflowUpdate> {
    return this.feed.stream<WorkflowUpdate>(request, this.channel(id), options);
  }

  /** A cursor at the workflow's channel head, for a view to hand its client. */
  cursor(id: string): Promise<string> {
    return this.feed.cursor(this.channel(id));
  }

  /**
   * Follows workflow `id` on the server: yields it as it is now, then each
   * newer update, and ends after the one that ended it. Yields nothing for
   * an unknown id.
   */
  async *subscribe(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<WorkflowUpdate, void, undefined> {
    const subscription = this.feed.subscribe(this.channel(id), { signal: options.signal });
    try {
      await subscription.ready();
      let current = await this.update(id);
      if (!current) return;
      yield current;
      if (workflowEnded(current.status)) return;
      const events = subscription[Symbol.asyncIterator]();
      let pending = events.next();
      for (;;) {
        const next = await raceTimeout(pending, RECHECK_MS);
        let update: WorkflowUpdate | null;
        if (next === "timeout") {
          update = await this.update(id);
        } else {
          if (next.done) return;
          pending = events.next();
          update = updateOf(next.value, id) ?? (await this.update(id));
        }
        if (!update || update.updatedAt < current.updatedAt) continue;
        if (JSON.stringify(update) === JSON.stringify(current)) continue;
        current = update;
        yield current;
        if (workflowEnded(current.status)) return;
      }
    } finally {
      subscription.close();
    }
  }

  /**
   * The store, with every change scheduling a publish of the workflow it
   * changed. Publishes are coalesced: at most one per workflow every
   * `PUBLISH_INTERVAL_MS`, each carrying the workflow as it is then, so the
   * last change is always published.
   */
  private publishingStore(store: WorkflowStore): WorkflowStore {
    const changed = (id: string) => void afterCommit(() => this.schedulePublish(id));
    const wrapped: WorkflowStore = {
      create: (workflow) =>
        store.create(workflow).then((value) => {
          changed(workflow.id);
          return value;
        }),
      find: (id, options) => store.find(id, options),
      acquire: (id, owner, leaseMs) => store.acquire(id, owner, leaseMs),
      renew: (id, owner, leaseMs) => store.renew(id, owner, leaseMs),
      update: (id, options, decide) =>
        store.update(id, options, decide).then((value) => {
          changed(id);
          return value;
        }),
    };
    if (store.joinsTransaction) wrapped.joinsTransaction = () => store.joinsTransaction!();
    if (store.listItems) wrapped.listItems = (...args) => store.listItems!(...args);
    if (store.prune) wrapped.prune = (olderThanMs) => store.prune!(olderThanMs);
    return wrapped;
  }

  private schedulePublish(id: string) {
    if (this.publishing.has(id)) return;
    const wait = Math.max(0, (this.published.get(id) ?? 0) + PUBLISH_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      this.publishing.delete(id);
      this.published.set(id, Date.now());
      void this.publish(id);
    }, wait);
    timer.unref?.();
    this.publishing.set(id, timer);
  }

  private async publish(id: string) {
    try {
      const update = await this.update(id);
      if (!update) return;
      if (workflowEnded(update.status)) this.published.delete(id);
      await this.feed.publish(this.channel(id), update);
    } catch (error) {
      console.error(`[gemi] Workflow ${id}: could not publish its change.`, error);
    }
  }

  /** Ends this runtime's own feed, if it made one, and drops pending publishes. For tests. */
  async close(): Promise<void> {
    for (const timer of this.publishing.values()) clearTimeout(timer);
    this.publishing.clear();
    await this.ownFeed?.close();
    this.ownFeed = undefined;
  }

  start(workflow: WorkflowClass, args: unknown[]): Promise<string> {
    if (workflow.name === "unset" || !workflow.name) {
      throw new Error("Cannot start a workflow with no name");
    }
    const store = this.store;
    const record = {
      id: Bun.randomUUIDv7(),
      name: workflow.name,
      args: encode(args, `The arguments of ${workflow.name}`) ?? "[]",
    };
    const wake = () => this.queue.claimSoon();

    // As `QueueManager.push`: on the caller's transaction when the store
    // joins it, otherwise held until it commits.
    const joins = store.joinsTransaction?.() === true;
    if (!joins) {
      const held = deferUntilCommit(() =>
        store.create(record).then(wake, (error: unknown) => {
          console.error(
            `[gemi] The queue could not record the workflow ${workflow.name}, which ` +
              `was held until its transaction committed. The transaction stays ` +
              `committed; the workflow did not start.`,
            error,
          );
        }),
      );
      if (held) return Promise.resolve(record.id);
    }
    const written = store.create(record);
    const wakeAtCommit = joins && deferUntilCommit(wake);
    return written.then(() => {
      if (!wakeAtCommit) wake();
      return record.id;
    });
  }

  async signal(id: string, key: string, payload?: unknown): Promise<boolean> {
    if (typeof key !== "string" || key.length === 0 || key.length > 191) {
      throw new TypeError(`A signal key is a string of 1 to 191 characters.`);
    }
    const output = encode(payload, `The payload of signal "${key}"`);
    const taken = await this.store.update(id, { key }, ({ workflow, step, now }) => {
      if (ENDED.includes(workflow.status) || workflow.status === "cancelling") {
        return { result: false };
      }
      if (!step) {
        return {
          result: true,
          step: {
            workflowId: id,
            key,
            status: "signalled",
            attempt: 0,
            output,
            error: null,
            batchId: null,
            wakeAt: null,
            startedAt: null,
            finishedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (step.status !== "waiting") return { result: false };
      return {
        result: true,
        step: { ...step, status: "signalled", output, wakeAt: step.wakeAt, finishedAt: now },
        tick: { delayMs: 0 },
      };
    });
    if (taken) this.queue.claimSoon();
    return taken === true;
  }

  async cancel(id: string): Promise<boolean> {
    const cancelled = await this.store.update(id, { allSteps: true }, ({ workflow, steps }) => {
      if (ENDED.includes(workflow.status) || workflow.status === "cancelling") {
        return { result: false };
      }
      return {
        result: true,
        workflow: { status: "cancelling" },
        cancelBatches: steps
          .filter((step) => step.status === "batching" && step.batchId !== null)
          .map((step) => step.batchId!),
        tick: { delayMs: 0 },
      };
    });
    if (cancelled) this.queue.claimSoon();
    return cancelled === true;
  }

  async find(id: string): Promise<WorkflowStatus | null> {
    const state = await this.store.find(id);
    if (!state) return null;
    const { workflow, steps } = state;
    let args: unknown[] = [];
    try {
      args = JSON.parse(workflow.args) as unknown[];
    } catch {}
    return {
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      args,
      currentStep: workflow.currentStep,
      progress: workflow.progress,
      result: safeDecode(workflow.result),
      error: workflow.error,
      steps: await Promise.all(
        steps.map(async (step) => {
          const status = {
            key: step.key,
            status: step.status,
            attempt: step.attempt,
            error: step.error,
            batchId: step.batchId,
            wakeAt: step.wakeAt,
            startedAt: step.startedAt,
            finishedAt: step.finishedAt,
          };
          const items = eachProgressOf(step.output);
          if (items) {
            return {
              ...status,
              items,
              progress: items.total === 0 ? 1 : items.done / items.total,
            };
          }
          if (step.batchId === null) return status;
          const batch = await this.queue.driver.findBatch?.(step.batchId);
          return batch ? { ...status, progress: batch.progress } : status;
        }),
      ),
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    };
  }

  async items(
    id: string,
    key: string,
    options: { status?: "failed" | "skipped"; after?: number; limit?: number } = {},
  ): Promise<EachProblem[]> {
    const store = this.store;
    if (!store.listItems) return [];
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)));
    const rows = await store.listItems(id, key, {
      statuses: options.status ? [options.status] : ["failed", "skipped"],
      ...(options.after === undefined ? {} : { after: options.after }),
      limit,
    });
    return rows.map(problemOf);
  }

  /** One pass of the workflow `id`, run by its tick job. */
  async tick(id: string, job: Job): Promise<void> {
    const store = this.store;
    const claimed = job.$claimed;
    const owner = claimed
      ? `${claimed.id}:${claimed.attempt}`
      : `${crypto.randomUUID()}:1`;
    const lease = Math.max(1, this.queue.config.visibilityTimeout);
    const acquired = await store.acquire(id, owner, lease);
    if (acquired.kind !== "acquired") return;
    const { workflow } = acquired;

    const letGo = (change: Partial<WorkflowChange<undefined>> = {}) =>
      store
        .update(id, { owner }, () => ({ ...change, result: undefined, unlock: true }))
        .then(() => this.queue.claimSoon())
        .catch((error) => {
          if (!(error instanceof WorkflowLeaseLostError)) throw error;
        });

    if (ENDED.includes(workflow.status)) return letGo();

    const Class = this.registry[workflow.name];
    if (!Class) return this.unknown(workflow, job, letGo);

    let args: unknown[];
    try {
      args = JSON.parse(workflow.args) as unknown[];
    } catch (error) {
      return letGo({
        workflow: { status: "failed", error: `The arguments are not JSON: ${describe(error)}` },
      });
    }

    const renew = setInterval(
      () => {
        store.renew(id, owner, lease).catch((error) => {
          console.error(`[gemi] Could not extend the hold on workflow ${id}.`, error);
        });
      },
      Math.max(1, Math.floor(lease / 3)),
    );
    renew.unref?.();

    const cancelling = workflow.status === "cancelling";
    const step = new Step({
      workflowId: id,
      owner,
      store,
      steps: acquired.steps,
      cancelling,
      findBatch: (batchId) =>
        this.queue.driver.findBatch?.(batchId, { progress: false }) ?? Promise.resolve(null),
      buildBatch: (batchJob, tuples, options) =>
        this.queue.buildBatch(
          batchJob,
          tuples.map((tuple) => JSON.stringify(tuple)),
          {
            name: options.name,
            allowFailures: options.allowFailures,
            finally: { name: WORKFLOW_TICK_JOB, args: [id] },
          },
        ),
      scheduled: () => this.queue.claimSoon(),
      cancelCheckMs: CANCEL_CHECK_MS,
      durable: this.queue.durable,
    });

    try {
      let outcome: Outcome;
      try {
        const instance = new Class();
        const value = await (cancelling
          ? instance.onCancel(step, ...args)
          : instance.run(step, ...args));
        outcome = step.suspension
          ? { kind: "suspended" }
          : {
              kind: "completed",
              result: cancelling ? null : encode(value, `The result of ${workflow.name}`),
            };
      } catch (error) {
        outcome =
          step.suspension || error instanceof WorkflowSuspended
            ? { kind: "suspended" }
            : { kind: "failed", error: describe(error) };
        if (error instanceof WorkflowLeaseLostError) step.lost = true;
      }
      // A step the code did not await (or one that ran beside a sleep in a
      // `Promise.all`) is still writing; it finishes inside this pass.
      await step.settled();
      if (step.lost) return;
      // One of those suspended the workflow after `run` had returned: it is
      // not done until that step is.
      if (outcome.kind === "completed" && step.suspension) outcome = { kind: "suspended" };

      await store.update(id, { owner }, ({ workflow: current, now }) =>
        this.finish(current, outcome, step, cancelling, now),
      );
      this.queue.claimSoon();
    } catch (error) {
      if (error instanceof WorkflowLeaseLostError) return;
      throw error;
    } finally {
      clearInterval(renew);
    }
  }

  /** The tick's last write: the pass's outcome, and letting go. */
  private finish(
    current: WorkflowRecord,
    outcome: Outcome,
    step: Step,
    cancelling: boolean,
    now: number,
  ): WorkflowChange<undefined> {
    const change: WorkflowChange<undefined> = { result: undefined, unlock: true };

    // Cancelled during this pass of `run`: `onCancel` is next, whatever the
    // pass came to.
    if (current.status === "cancelling" && !cancelling) {
      return { ...change, tick: { delayMs: 0 } };
    }

    if (outcome.kind === "completed") {
      return {
        ...change,
        workflow: cancelling
          ? { status: "cancelled", currentStep: null, wakeAt: null }
          : {
              status: "completed",
              result: outcome.result,
              progress: 1,
              currentStep: null,
              wakeAt: null,
              error: null,
            },
      };
    }
    if (outcome.kind === "failed") {
      return {
        ...change,
        workflow: { status: cancelling ? "cancelled" : "failed", error: outcome.error, wakeAt: null },
      };
    }

    const suspension = step.suspension ?? { status: "waiting" as const, wakes: [] };
    const next: WorkflowChange<undefined> = {
      ...change,
      workflow: {
        status: cancelling ? "cancelling" : suspension.status,
        currentStep: step.current ?? current.currentStep,
      },
    };
    if (suspension.wakes.length > 0) {
      const wakeAt = Math.min(...suspension.wakes);
      // A tick already scheduled no later than this one wakes the workflow
      // in time, and schedules this one itself; a second would only run the
      // pass twice.
      const scheduled =
        current.wakeAt !== null && current.wakeAt > now && current.wakeAt <= wakeAt;
      if (!scheduled) {
        next.tick = { delayMs: Math.max(0, wakeAt - now) };
        next.workflow!.wakeAt = wakeAt;
      }
    }
    return next;
  }

  /**
   * A tick for a workflow this process has no class for. During a
   * blue/green ramp that is usually one only the other release has, so on a
   * shared driver it goes back for another replica until `unknownJobGrace`
   * has passed since the workflow started; then it fails.
   */
  private async unknown(
    workflow: WorkflowRecord,
    job: Job,
    letGo: (change?: Partial<WorkflowChange<undefined>>) => Promise<void>,
  ) {
    const age = Date.now() - workflow.createdAt;
    if (this.queue.durable && age < this.queue.config.unknownJobGrace) {
      if (!this.reportedNames.has(workflow.name)) {
        this.reportedNames.add(workflow.name);
        console.error(
          `Left workflow "${workflow.name}" for another replica: nothing is ` +
            `registered here under that name.`,
        );
      }
      await letGo();
      job.release(Math.round(this.queue.config.pollInterval * (1 + Math.random())));
      return;
    }
    console.error(
      `Failed workflow ${workflow.id}: nothing is registered under the name ` +
        `"${workflow.name}". If the class exists, it was not discovered: check ` +
        `that it is under the queue slice's workflowsDir (app/workflows by ` +
        `default), or list it in app/config/queue.ts.`,
    );
    await letGo({
      workflow: {
        status: "failed",
        error: `No workflow is registered under the name "${workflow.name}".`,
      },
    });
  }

  /**
   * The tick job ran out of attempts, which only a store that stayed
   * unreachable causes. Fails the workflow if it still can, so it does not
   * sit in `running` with nothing left to advance it.
   */
  /** @internal */
  tickDeadLettered(id: string, error: Error) {
    console.error(`[gemi] The tick of workflow ${id} was dead-lettered.`, error);
    void this.store
      .update(id, {}, ({ workflow }) =>
        ENDED.includes(workflow.status)
          ? { result: undefined }
          : {
              result: undefined,
              workflow: {
                status: "failed",
                error: `Its tick job was dead-lettered: ${error.message}`,
              },
              unlock: true,
            },
      )
      .catch(() => {});
  }
}

/** The internal job a workflow's passes run in, bound to one runtime. */
function tickJobFor(runtime: WorkflowRuntime): new () => Job {
  return class WorkflowTickJob extends Job {
    static name = WORKFLOW_TICK_JOB;
    // A tick fails only when the store cannot be reached (a workflow's own
    // errors are recorded, not thrown), so it keeps trying for a while rather
    // than leaving the workflow stuck.
    maxAttempts = 20;
    backoff = [1000, 5000, 15000, 30000, 60000];
    async run(id: string) {
      await runtime.tick(id, this);
    }
    onDeadletter(error: Error, id: string) {
      runtime.tickDeadLettered(id, error);
    }
  };
}

function safeDecode(output: string | null): unknown {
  try {
    return decode(output);
  } catch {
    return output;
  }
}

/** The update a change event carries, when it is one for workflow `id`. */
function updateOf(event: ChangeFeedEvent, id: string): WorkflowUpdate | null {
  if (event.type !== "change") return null;
  const data = event.data as Partial<WorkflowUpdate> | null;
  if (!data || typeof data !== "object" || data.id !== id || typeof data.updatedAt !== "number") {
    return null;
  }
  return data as WorkflowUpdate;
}

/** What `promise` resolves to, or `"timeout"` after `ms`. */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
