import { Storage } from "../../facades/Storage";
import { app } from "../../foundation/app";
import { Job } from "../../services/queue/Job";
import { QueueManager } from "../../services/queue/QueueManager";
import type { GeneratedAttachment, ToolGenerateImageParams, ToolEditImageParams } from "../Agent";
import { generateWithin, type GenerateParams, type GenerateResult } from "../generate";
import type { ImageInput, ImageModel } from "../ImageModel";
import { redactError, ToolError } from "../redact";
import { addUsage, emptyUsage } from "../runtime";
import type { Infer, Schema } from "../Schema";
import {
  type Attachment,
  type AttachmentStorage,
  type AttachmentStore,
  defaultAttachmentStore,
  InvalidAttachmentScopeError,
  ScopedAttachments,
} from "../store/Attachments";
import type { AgentError, Usage } from "../types";
import {
  type AgentJobRecord,
  type AgentJobState,
  type AgentJobStore,
  isSettled,
  MemoryAgentJobStore,
} from "./AgentJobStore";

// --- the handle a tool returns -------------------------------------------

const HANDLE = Symbol.for("gemi.ai.JobHandle");

/**
 * What `ctx.jobs.start` and `ctx.jobs.track` answer, and what a tool returns to
 * say "this call goes on in the background" (#461).
 *
 * Returning it is what makes the call's result `running` rather than `ok`: the
 * model reads that the job started and is told not to start it again, the turn
 * goes on and ends as usual, and when the job settles the controller renders
 * its outcome over that result the next time it loads the thread.
 *
 * `Output` is the job's settled output, and it is what the tool's output type
 * becomes, so a client's `ToolShapes` see the job's result as the tool's.
 */
export class JobHandle<Output = unknown> {
  /** Phantom: the settled output's type. Never set. */
  declare readonly $output: Output;
  readonly [HANDLE] = true as const;

  constructor(
    /** The job's id. Hand it to whatever settles a tracked job. */
    readonly id: string,
    readonly toolCallId: string,
    readonly summary: unknown,
    /** Epoch milliseconds, on the job store's clock. */
    readonly deadlineAt: number,
  ) {}
}

/** Whether a tool's return value is a `JobHandle`, across copies of the module. */
export function isJobHandle(value: unknown): value is JobHandle {
  return typeof value === "object" && value !== null && (value as any)[HANDLE] === true;
}

// --- errors ----------------------------------------------------------------

/**
 * `ctx.jobs.start` or `track` from a run that has nowhere to settle a job
 * into: a stateless turn, a run started without a job store, or a sub-run.
 *
 * A `ToolError`, so the model reads why the tool could not go to the
 * background and can say so, rather than being told the tool broke.
 */
export class JobsRequireThreadError extends ToolError {
  readonly code = "jobs_require_thread" as const;

  constructor(message: string) {
    super(message, { retryable: false });
    this.name = "JobsRequireThreadError";
  }
}

// --- the process-wide registry ----------------------------------------------

let currentStore: AgentJobStore = new MemoryAgentJobStore();

/**
 * What `AgentJobs.onSettled` calls, once per job, with the job as it settled
 * (#1179): `state` is `"ok"` or `"error"` (a deadline is `error.code`
 * `"timeout"`).
 */
export type AgentJobSettledListener = (record: AgentJobRecord) => void | Promise<void>;

const settledListeners = new Set<AgentJobSettledListener>();

/** Every state, for a transition that does not change the state. */
const ANY_STATE: AgentJobState[] = ["waiting", "running", "ok", "error"];

/** Jobs cancelled with `silent`: settled without telling `onSettled`'s listeners. */
const quiet = new Set<string>();

/** The jobs this process is running, so a cancel here aborts their `signal` at once. */
const runningHere = new Map<string, AbortController>();

/** What `AgentJobs.onSettledBatch` calls: the settled jobs of one key, in the order they settled. */
export type AgentJobBatchListener = (jobs: AgentJobRecord[], key: string) => void | Promise<void>;

/** Options for `AgentJobs.onSettledBatch`. */
export type AgentJobBatchOptions = {
  /**
   * How long a report waits for more jobs to settle, in milliseconds, so
   * jobs settling close together are reported in one call. Each settle under
   * the same key starts the wait again. Default 1000.
   */
  delayMs?: number;
  /**
   * The longest a settled job waits for the quiet `delayMs` asks for, in
   * milliseconds, when jobs keep settling. Default 10 × `delayMs`.
   */
  maxDelayMs?: number;
  /** Which jobs are reported together. Default the job's `threadId`. */
  key?: (job: AgentJobRecord) => string;
  /**
   * Holds the key's ready reports back: `true` until the next settle under
   * the key or a `flush(key)`, a number to look again after that many
   * milliseconds, `false` (or nothing) to report them now. For a person's
   * open question, say, which a turn on the thread would close.
   */
  hold?: (
    jobs: AgentJobRecord[],
    key: string,
  ) => boolean | number | void | Promise<boolean | number | void>;
};

/** What `AgentJobs.onSettledBatch` answers: removes the listener, and `flush`es on demand. */
export type AgentJobBatchSubscription = (() => void) & {
  /**
   * Looks at a key's held reports again (all keys without one), as a settle
   * would, after its `delayMs`; `{ now: true }` skips the wait.
   */
  flush(key?: string, options?: { now?: boolean }): void;
};

/** Options for `AgentJobs.cancel`. */
export type CancelJobOptions = {
  /** What the job's error says, which the model reads. */
  reason?: string;
  /**
   * Settle it, and the jobs that waited for it, without calling `onSettled`
   * listeners: the caller tells whoever needs to know itself.
   */
  silent?: boolean;
};

/** Options for `AgentJobs.start` and `AgentJobs.track`: a job started from server code. */
export type ServerJobOptions = Omit<StartJobOptions, "after"> & {
  /**
   * The thread the job belongs to: it is listed in that thread's `<jobs>`
   * block, and `onSettledBatch` groups by it by default. Default none (`""`).
   */
  threadId?: string;
  /** Who it is for, as a run's `runOwner`. Default `null`. */
  owner?: string | null;
  /** What it is called in the `<jobs>` block and on the record (`toolName`). Default the class's name. */
  name?: string;
  /** The attachment scope key its `job.attachments` use. Default none. */
  attachmentScope?: string | null;
  /** The jobs it starts after. See `StartJobOptions.after`. Not for `track`. */
  after?: string[];
};

/** What a job settles with. */
export type AgentJobOutcome =
  | { output: unknown; usage?: Usage }
  | { error: string | Error | (Pick<AgentError, "message"> & Partial<AgentError>); usage?: Usage };

/**
 * Background jobs, from anywhere in the app: settle one, fail one, look one up.
 *
 * PROCESS-WIDE, and that is forced. A job is started by a tool inside a run,
 * and settled by a queue worker, a provider's webhook, a poller or the deadline
 * sweep, none of which has a controller to read a store from. So the store is
 * set once, at boot, for every one of them:
 *
 *     AgentJobs.use(new DatabaseAgentJobStore(app(DatabaseManager).connection()));
 *
 * Until then it is a `MemoryAgentJobStore`, which works in one process and
 * forgets on restart.
 */
export const AgentJobs = {
  /** The store every part of the feature reads and writes. */
  get store(): AgentJobStore {
    return currentStore;
  },

  /** Sets the store. Call it once, at boot, in every process that starts or runs jobs. */
  use(store: AgentJobStore): void {
    currentStore = store;
  },

  get(id: string): Promise<AgentJobRecord | null> {
    return currentStore.get(id);
  },

  /**
   * Calls `listener` each time a job settles in this process, and answers a
   * function that removes it (#1179). This is how an app continues a thread
   * when its work is done, rather than waiting for the person to speak:
   *
   *     AgentJobs.onSettled(async (job) => {
   *       await ChatController.startTurn({
   *         threadId: job.threadId,
   *         user: await userFor(job.owner),
   *         ifBusy: "queue", // don't cut off an answer that's being read
   *       });
   *     });
   *
   * Called by whichever settle wins the compare-and-set, so once per job
   * however many race: `settle` and `fail`, an `AgentJob`'s result or dead
   * letter, the deadline sweep, and the expiry of an overdue job when a
   * thread is loaded. Not for a job that could not be queued: the tool call
   * that started it fails in its own turn.
   *
   * IN THE PROCESS THAT SETTLED THE JOB, which is often a queue worker or the
   * one that took a webhook: register it at boot in every process that
   * settles jobs, as for `AgentJobs.use`. The turn it starts runs in that
   * process too (see `startTurn`). Settling does not wait for listeners, and a
   * listener that throws or rejects is logged, not thrown into the settle.
   */
  onSettled(listener: AgentJobSettledListener): () => void {
    settledListeners.add(listener);
    return () => {
      settledListeners.delete(listener);
    };
  },

  /**
   * Settles a running job with its output or its error, and answers whether
   * this call did it.
   *
   * COMPARE-AND-SET FROM `running`. The first settle wins and every later one
   * answers `false` and changes nothing, so a webhook, a poller and the
   * deadline sweep can all race on one job. A job the deadline sweep has
   * already failed stays failed: a late result is refused, so the model never
   * sees a job flip from failed to done.
   *
   * An error given as a `ToolError`, a string or an `AgentError`-like object is
   * shown to the model as it is. Any other `Error` is logged in full and the
   * model is told only that the job failed, as for a tool that throws (#446).
   */
  async settle(id: string, outcome: AgentJobOutcome): Promise<boolean> {
    return settleOn(currentStore, id, outcome);
  },

  /** `settle(id, { error })`. */
  async fail(id: string, error: string | Error | AgentError): Promise<boolean> {
    return settleOn(currentStore, id, { error });
  },

  /**
   * The deadline sweep: fails every running job whose deadline has passed
   * with code `"timeout"`, and answers how many it failed.
   *
   * Compare-and-set like every settle, so it is safe to run on every
   * instance at once, and a result that arrives after it is refused. Run it
   * every minute with `AgentJobDeadlineSweep`; the controller also checks a
   * thread's jobs when it loads the thread, so an app without cron still sees
   * overdue jobs fail, just later. The job's queue worker is not stopped: what
   * it returns afterwards is dropped.
   */
  async sweep(options: { limit?: number } = {}): Promise<number> {
    const store = currentStore;
    const limit = options.limit ?? 100;
    const now = await clockOf(store);
    let failed = 0;
    for (const record of await store.overdue(now, limit)) {
      if (await expire(store, record)) failed++;
    }
    // A waiting job whose dependencies settled in a process that died before
    // it could start them: started (or cancelled) here instead.
    if (store.waiting) {
      for (const record of await store.waiting(limit)) {
        try {
          await advance(store, record);
        } catch (error) {
          console.error(`Could not advance waiting background job ${record.id}.`, error);
        }
      }
    }
    return failed;
  },

  /**
   * Starts a background job from server code rather than from a tool (#1222):
   * an orchestrator handing out several tasks at once, a webhook, a cron.
   * Nothing in a thread's history points at it (its `toolCallId` is `""`), so
   * its result is read from the record, `onSettled` or `onSettledBatch`.
   *
   *     const plan = await AgentJobs.start(BuildJob, { task: "the data" }, { threadId, batch });
   *     await AgentJobs.start(BuildJob, { task: "the pages" }, { threadId, batch, after: [plan.id] });
   *
   * With `after`, the job is `waiting` until those jobs settle `ok`. At least
   * once, like every queued job: make `run` idempotent.
   */
  async start<A, O>(
    job: AgentJobClass<A, O>,
    args: A,
    options: ServerJobOptions = {},
  ): Promise<JobHandle<O>> {
    const record = await createJob(serverFields(options, job.name), {
      job: job as new () => AgentJob<any, any>,
      args,
      options,
    });
    return handleOf(record);
  },

  /**
   * Records a background job from server code that something else settles
   * (`AgentJobs.settle`): `ctx.jobs.track` without a tool call.
   */
  async track<O = unknown>(options: Omit<ServerJobOptions, "after"> = {}): Promise<JobHandle<O>> {
    const record = await createJob(serverFields(options, "job"), {
      job: null,
      args: undefined,
      options,
    });
    return handleOf(record);
  },

  /**
   * Cancels a waiting or running job (#1222), and answers whether this call
   * did: it settles `error` with code `"cancelled"`, and every job waiting
   * for it (`after`), and for those, is cancelled too. False once it has
   * settled.
   *
   * A running `AgentJob` sees `job.signal` abort: at once in this process,
   * and within its `cancelCheckMs` in another. What it changed already
   * stays, and what it returns afterwards is dropped. A tracked job is only
   * marked: tell whatever does the work yourself.
   */
  async cancel(id: string, options: CancelJobOptions = {}): Promise<boolean> {
    const store = currentStore;
    const record = await store.get(id);
    if (!record || isSettled(record.state)) return false;
    if (options.silent) quiet.add(id);
    const won = await store.transition(id, ["waiting", "running"], {
      state: "error",
      error: {
        code: "cancelled",
        message: options.reason ?? `The background job for "${record.toolName}" was cancelled.`,
        ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
        retryable: false,
      },
    });
    if (!won) {
      quiet.delete(id);
      return false;
    }
    await afterSettle(store, id);
    return true;
  },

  /**
   * Leaves a message for a waiting or running job (#1222), and answers
   * whether it did: false once the job has settled. The job takes its
   * messages with `job.inbox.take()`; handed to `agent.stream({ inbox })`,
   * the run adds each as a user message before its next model call. A
   * waiting job gets them when it starts. Messages it never took stay on
   * the settled record (`inbox`).
   */
  async message(id: string, text: string): Promise<boolean> {
    const store = currentStore;
    if (!store.appendInbox) {
      throw new Error(
        "AgentJobs.message needs a job store with an inbox (appendInbox and takeInbox).",
      );
    }
    return store.appendInbox(id, text);
  },

  /**
   * Calls `listener` with settled jobs in batches (#1222), and answers a
   * function that removes it (with `flush`). Use it in place of
   * `onSettled` to wake an agent once for work that ends close together:
   *
   *     AgentJobs.onSettledBatch(async (jobs, threadId) => {
   *       await ChatController.startTurn({ threadId, user, ifBusy: "queue", event: { name: "work-settled", data: { jobs } } });
   *     });
   *
   * - Jobs are grouped by `key` (the thread, by default), and a group is
   *   reported `delayMs` after its last settle (at most `maxDelayMs` after its
   *   first).
   * - A job started with a `batch` waits until every other unsettled job of
   *   that batch builds on it (lists it in `after`, directly or through
   *   another), so a batch is reported together and a report never arrives
   *   before the work it would mention.
   * - `hold` keeps ready reports back (a question the person has open).
   * - One call per key at a time, in this process: settles meanwhile are
   *   reported in the next call. Cancelled with `silent` are not reported.
   *
   * Like `onSettled`, it hears the settles of this process only.
   */
  onSettledBatch(
    listener: AgentJobBatchListener,
    options: AgentJobBatchOptions = {},
  ): AgentJobBatchSubscription {
    const batcher = new SettledBatcher(listener, options);
    const off = AgentJobs.onSettled((record) => batcher.add(record));
    const subscription = (() => {
      off();
      batcher.stop();
    }) as AgentJobBatchSubscription;
    subscription.flush = (key, flushOptions) => batcher.flush(key, flushOptions?.now === true);
    return subscription;
  },
};

/** The record fields of a job started from server code. */
function serverFields(options: Omit<ServerJobOptions, "after">, fallbackName: string): JobFields {
  return {
    threadId: options.threadId ?? "",
    runId: "",
    toolCallId: "",
    toolName: options.name ?? fallbackName,
    owner: options.owner ?? null,
    attachmentScope: options.attachmentScope ?? null,
    deadlineMs: options.deadlineMs ?? DEFAULT_JOB_DEADLINE_MS,
  };
}

/** What a new job's record is made of, apart from what the start options say. */
type JobFields = {
  threadId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  owner: string | null;
  attachmentScope: string | null;
  deadlineMs: number;
};

/**
 * Writes a job's record and queues it: now, or once its `after` jobs settle
 * `ok`. Refuses a dependency that does not exist or has already failed.
 */
async function createJob(
  fields: JobFields,
  start: {
    job: (new () => AgentJob<any, any>) | null;
    args: unknown;
    options: StartJobOptions;
  },
): Promise<AgentJobRecord> {
  const store = AgentJobs.store;
  const { job, args, options } = start;
  const deadlineMs = fields.deadlineMs;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new ToolError(`A job's deadlineMs must be a positive number; got ${deadlineMs}.`);
  }
  const after = options.after ? [...new Set(options.after)] : [];
  let waiting = false;
  if (after.length > 0) {
    if (!job) {
      throw new ToolError("A tracked job cannot wait for others: `after` is only for `start`.", {
        retryable: false,
      });
    }
    if (!store.waitingOn) {
      throw new Error("`after` needs a job store that can list waiting jobs (waitingOn).");
    }
    for (const id of after) {
      const need = await store.get(id);
      if (!need) {
        throw new ToolError(`The job waits for ${id}, which does not exist.`, {
          retryable: false,
        });
      }
      if (need.state === "error") {
        throw new ToolError(
          `The job waits for ${id}, which did not finish (${need.error?.code ?? "error"}). Leave it out, or start that work again.`,
          { retryable: false },
        );
      }
      if (need.state !== "ok") waiting = true;
    }
  }
  if (job && (job.name === "unset" || !job.name)) {
    throw new Error("Cannot start an AgentJob with no `static name`.");
  }

  const write = async () => {
    const record = await store.create({
      id: `ajob_${crypto.randomUUID()}`,
      threadId: fields.threadId,
      runId: fields.runId,
      toolCallId: fields.toolCallId,
      toolName: fields.toolName,
      owner: fields.owner,
      job: job ? job.name : null,
      ...(options.summary !== undefined ? { summary: plainData(options.summary, fields) } : {}),
      attachmentScope: fields.attachmentScope,
      deadlineMs,
      ...(after.length > 0 ? { after } : {}),
      ...(options.batch !== undefined ? { batch: options.batch } : {}),
      ...(waiting
        ? { state: "waiting" as const, queued: { args: plainData(args, fields), deadlineMs } }
        : {}),
    });
    if (job && !waiting) {
      try {
        await dispatchJob(job, { jobId: record.id, args });
      } catch (error) {
        // In a store transaction the record goes with the rollback.
        if (store.transaction) throw error;
        // Nothing will ever run it, so it is failed now rather than left to
        // reach its deadline, and the caller hears of the failure.
        await store
          .transition(record.id, ["running"], {
            state: "error",
            error: {
              code: "tool_error",
              message: `The background job for "${fields.toolName}" could not be queued.`,
              ...(fields.toolCallId ? { toolCallId: fields.toolCallId } : {}),
              retryable: true,
            },
          })
          .catch(() => {});
        throw error;
      }
    }
    return record;
  };
  // Both or neither when the store can: see `AgentJobStore.transaction`.
  const record = store.transaction ? await store.transaction(write) : await write();
  // A dependency may have settled between the check above and the write,
  // with no one to start this job then: look again.
  if (waiting) await advance(store, record);
  return (await store.get(record.id)) ?? record;
}

/** The store's clock, or this process's for a store without one. */
export async function clockOf(store: AgentJobStore): Promise<number> {
  return store.now ? await store.now() : Date.now();
}

/** Fails a running job for its deadline. Compare-and-set: false when it had settled. */
export async function expire(store: AgentJobStore, record: AgentJobRecord): Promise<boolean> {
  const won = await store.transition(record.id, ["running"], {
    state: "error",
    error: {
      code: "timeout",
      message: `The background job for "${record.toolName}" did not finish before its deadline, so it was given up on. Its result, if it ever arrives, is ignored.`,
      toolCallId: record.toolCallId,
      retryable: true,
    },
  });
  if (won) await afterSettle(store, record.id);
  return won;
}

/**
 * What follows a settle this process won: the jobs that waited for it start
 * or are cancelled, then `onSettled`'s listeners hear about it. Never throws.
 */
async function afterSettle(store: AgentJobStore, id: string): Promise<void> {
  runningHere.get(id)?.abort(new ToolError("The background job was settled while it ran."));
  try {
    await releaseDependents(store, id);
  } catch (error) {
    console.error(`Could not start or cancel the jobs waiting for background job ${id}.`, error);
  }
  notifySettled(store, id);
}

/** Starts or cancels each waiting job whose `after` names `id`, now that `id` settled. */
async function releaseDependents(store: AgentJobStore, id: string): Promise<void> {
  if (!store.waitingOn) return;
  for (const waiting of await store.waitingOn(id)) await advance(store, waiting);
}

/**
 * A waiting job, once its `after` jobs settle: starts it when every one is
 * `ok`, cancels it when one failed or was cancelled (and so on down its own
 * dependents), and leaves it waiting otherwise. Compare-and-set from
 * `waiting`, so two processes advancing it at once start it once.
 */
async function advance(store: AgentJobStore, record: AgentJobRecord): Promise<void> {
  const after = record.after ?? [];
  const needs = await Promise.all(after.map((id) => store.get(id)));
  const missing = after.find((_, index) => needs[index] === null);
  const broken = needs.find((need) => need?.state === "error");
  if (missing !== undefined || broken) {
    const cancelled = broken?.error?.code === "cancelled";
    const brokenId = broken?.id ?? missing!;
    const won = await store.transition(record.id, ["waiting"], {
      state: "error",
      error: {
        code: cancelled ? "cancelled" : "dependency_failed",
        message: broken
          ? `It waited for ${brokenId}, which ${cancelled ? "was cancelled" : "failed"}, so it did not start.`
          : `It waited for ${brokenId}, which can no longer be found, so it did not start.`,
        ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
        retryable: false,
      },
    });
    if (won) {
      // A silent cancel stays silent down the line.
      if (quiet.has(brokenId)) quiet.add(record.id);
      await afterSettle(store, record.id);
    }
    return;
  }
  if (needs.some((need) => need!.state !== "ok")) return;
  const started = await store.transition(record.id, ["waiting"], {
    state: "running",
    ...(record.queued ? { deadlineMs: record.queued.deadlineMs } : {}),
  });
  if (!started) return;
  const job = record.job ? lookupJob(record.job) : undefined;
  if (!job) {
    // Nothing would ever run it: a tracked job waits for its settle as usual.
    if (record.job === null) return;
    await settleOn(store, record.id, {
      error: {
        code: "tool_error",
        message: `The background job ${record.job} is not registered with the queue, so it could not start.`,
        retryable: false,
      },
    });
    return;
  }
  try {
    await dispatchJob(job, { jobId: record.id, args: record.queued?.args });
  } catch (error) {
    console.error(`Could not queue background job ${record.id} after its dependencies.`, error);
    await settleOn(store, record.id, {
      error: {
        code: "tool_error",
        message: `The background job for "${record.toolName}" could not be queued.`,
        retryable: true,
      },
    });
  }
}

function lookupJob(name: string): (new () => AgentJob<any, any>) | undefined {
  try {
    return app(QueueManager).jobs[name] as (new () => AgentJob<any, any>) | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tells `onSettled`'s listeners about a job this process just settled. Not
 * awaited by the settle: a listener may start a turn that waits for another.
 */
function notifySettled(store: AgentJobStore, id: string): void {
  if (quiet.delete(id)) return;
  if (settledListeners.size === 0) return;
  const listeners = [...settledListeners];
  void (async () => {
    const record = await store.get(id);
    if (!record || !isSettled(record.state)) return;
    for (const listener of listeners) {
      try {
        await listener(record);
      } catch (error) {
        console.error(`An AgentJobs.onSettled listener failed for background job ${id}.`, error);
      }
    }
  })().catch((error) => {
    console.error(`Could not read background job ${id} for its onSettled listeners.`, error);
  });
}

async function settleOn(
  store: AgentJobStore,
  id: string,
  outcome: AgentJobOutcome,
): Promise<boolean> {
  const record = await store.get(id);
  if (!record || record.state !== "running") return false;
  const usage = outcome.usage ? addUsage(record.usage ?? emptyUsage(), outcome.usage) : undefined;
  const won =
    "error" in outcome
      ? await store.transition(id, ["running"], {
          state: "error",
          error: jobError(record, outcome.error),
          ...(usage ? { usage } : {}),
        })
      : await store.transition(id, ["running"], {
          state: "ok",
          output: plainData(outcome.output, record),
          ...(usage ? { usage } : {}),
        });
  if (won) await afterSettle(store, id);
  return won;
}

/** The error the model reads. See `AgentJobs.settle`. */
function jobError(
  record: Pick<AgentJobRecord, "toolCallId" | "toolName" | "job">,
  error: AgentJobOutcome extends infer O ? (O extends { error: infer E } ? E : never) : never,
): AgentError {
  if (typeof error === "string") {
    return { code: "tool_error", message: error, toolCallId: record.toolCallId, retryable: true };
  }
  if (error instanceof Error) {
    const raw: AgentError = {
      code: "tool_error",
      message: error.message,
      toolCallId: record.toolCallId,
      retryable: error instanceof ToolError ? error.retryable : true,
    };
    if (!(error instanceof ToolError)) {
      console.error(
        `The background job ${record.job ?? "(tracked)"} for "${record.toolName}" failed.`,
        error,
      );
    }
    return redactError(raw, { source: "tool", toolName: record.toolName, cause: error });
  }
  return {
    code: error.code ?? "tool_error",
    message: String(error.message),
    toolCallId: record.toolCallId,
    retryable: error.retryable ?? true,
  };
}

/** A copy of the output that any store can keep, or a throw that says why not. */
function plainData(output: unknown, record: Pick<AgentJobRecord, "toolName">): unknown {
  if (output === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(output));
  } catch (error) {
    throw new Error(
      `The output of the background job for "${record.toolName}" is not JSON: ${String(error)}`,
    );
  }
}

// --- the tool side ---------------------------------------------------------

/** Options for `ctx.jobs.start` and `ctx.jobs.track`. */
export type StartJobOptions = {
  /**
   * What the model and the UI see while the job runs, in place of a result:
   * which images, which pages. Plain data, and keep it small, since it is in
   * the history on every later turn.
   */
  summary?: unknown;
  /**
   * How long the job may run, in milliseconds. Defaults to the tool's
   * `async.deadlineMs`, else an hour. A job still running then is failed with
   * code `"timeout"` by the deadline sweep, and a later result is refused.
   */
  deadlineMs?: number;
  /**
   * The jobs this one starts after (#1222), by id: it is `waiting`, and not
   * queued, until each has settled `ok`, then starts with a fresh deadline.
   * When one fails or is cancelled it is cancelled too (`error.code`
   * `"dependency_failed"` or `"cancelled"`), and so are the jobs waiting for
   * it. A dependency that does not exist or has already failed is refused.
   * Only for `start`: a tracked job cannot wait.
   */
  after?: string[];
  /**
   * A label shared by the jobs started together (#1222): `onSettledBatch`
   * reports a batch's jobs together. See `AgentJobRecord.batch`.
   */
  batch?: string;
};

/** A tool's `ctx.jobs`. See `ToolContext.jobs`. */
export interface ToolJobs {
  /**
   * Records a background job for this tool call and queues `job` to do it.
   * Return the handle from `execute` to make the call's result `running`.
   *
   * At least once, like every queued job: `job.run` may run again after a
   * crash, so make it idempotent. Only on a threaded run (a turn with a
   * `threadId` through `AgentController`), and only from a top-level tool.
   */
  start<A, O>(job: AgentJobClass<A, O>, args: A, options?: StartJobOptions): Promise<JobHandle<O>>;
  /**
   * Records a background job that something else settles: a provider's
   * webhook, a poller. Pass `handle.id` to it, and call
   * `AgentJobs.settle(id, { output })` when the work is done.
   */
  track<O = unknown>(options?: StartJobOptions): Promise<JobHandle<O>>;
}

/** What a run that may start jobs is given. `AgentController` passes it on a threaded turn. */
export type RunJobs = {
  /** The run's owner (`runOwner`), recorded on each job. */
  owner: string | null;
};

/** The longest a job runs when nothing says otherwise. */
export const DEFAULT_JOB_DEADLINE_MS = 60 * 60_000;

/** @internal `ctx.jobs` for one tool call. Built by the run, per call. */
export function toolJobs(params: {
  jobs: RunJobs | undefined;
  threadId: string | undefined;
  runId: string;
  toolCallId: string;
  toolName: string;
  depth: number;
  /** The tool's `async` declaration; `undefined` for a tool without one. */
  async: { deadlineMs?: number } | undefined;
  attachments: ScopedAttachments | null;
}): ToolJobs {
  /** One job per tool call: the handle the first `start`/`track` answered. */
  let started: Promise<JobHandle<any>> | null = null;

  const begin = (
    job: (new () => AgentJob<any, any>) | null,
    args: unknown,
    options: StartJobOptions = {},
  ) => {
    if (params.async === undefined) {
      throw new ToolError(
        `"${params.toolName}" called ctx.jobs, but the tool does not declare \`async\`. Add \`async: { deadlineMs }\` to its definition.`,
        { retryable: false },
      );
    }
    if (!params.jobs || !params.threadId) {
      throw new JobsRequireThreadError(
        `"${params.toolName}" can only run in the background on a conversation the server keeps (a turn with a threadId), and this one has none.`,
      );
    }
    if (params.depth > 0) {
      throw new JobsRequireThreadError(
        `"${params.toolName}" can only run in the background from the top-level agent, not from a sub-agent.`,
      );
    }
    if (started) {
      throw new ToolError(
        `"${params.toolName}" started a background job already: a tool call has at most one.`,
        { retryable: false },
      );
    }
    const deadlineMs = options.deadlineMs ?? params.async.deadlineMs ?? DEFAULT_JOB_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new ToolError(`A job's deadlineMs must be a positive number; got ${deadlineMs}.`);
    }
    const jobs = params.jobs;
    const threadId = params.threadId;
    started = (async () => {
      // A tool re-entered after an escalation runs from the top again. The job
      // it started the first time is the one it gets.
      const existing = (await AgentJobs.store.listForThread(threadId, { limit: 50 })).find(
        (record) => record.toolCallId === params.toolCallId,
      );
      if (existing) return handleOf(existing);
      const record = await createJob(
        {
          threadId,
          runId: params.runId,
          toolCallId: params.toolCallId,
          toolName: params.toolName,
          owner: jobs.owner,
          attachmentScope: params.attachments?.scopeKey ?? null,
          deadlineMs,
        },
        { job, args, options },
      );
      return handleOf(record);
    })();
    return started;
  };

  return {
    start: (job, args, options) => begin(job as new () => AgentJob<any, any>, args, options),
    track: (options) => begin(null, undefined, options),
  };
}

function handleOf(record: AgentJobRecord): JobHandle<any> {
  return new JobHandle(record.id, record.toolCallId, record.summary, record.deadlineAt);
}

/** What the queue carries for an `AgentJob`: the record's id and the job's own arguments. */
type JobEnvelope = { jobId: string; args: unknown };

function dispatchJob(job: new () => AgentJob<any, any>, envelope: JobEnvelope): Promise<string> {
  return app(QueueManager).push(job, JSON.stringify([envelope]));
}

// --- the job side ------------------------------------------------------------

/** An `AgentJob` subclass, as `ctx.jobs.start` takes it. */
export type AgentJobClass<A, O> = new () => AgentJob<A, O>;

/** `generateImage`'s params inside a job: as in a tool, without `showModel` (there is no run to show). */
export type JobGenerateImageParams = Omit<ToolGenerateImageParams, "showModel">;
export type JobEditImageParams = Omit<ToolEditImageParams, "showModel">;

/** Attachments inside a job: the scope of the run that started it. */
export interface JobAttachments {
  put(blob: Blob, params?: { name?: string; mimeType?: string }): Promise<Attachment>;
  get(id: string): Promise<Attachment>;
  read: ScopedAttachments["read"];
  file(id: string): Promise<File>;
}

/**
 * What `AgentJob.run` is handed beside its arguments: the parts of a tool's
 * `ToolContext` that still mean something with no run around them.
 */
export interface AgentJobContext {
  /** The job's id (`ajob_…`). */
  readonly id: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** The `runOwner` of the run that started it. */
  readonly owner: string | null;
  readonly summary: unknown;
  /** The jobs it started after (`after`), all settled `ok`. Read their outputs with `AgentJobs.get`. */
  readonly after: readonly string[];
  /** Its batch, if it was started with one. */
  readonly batch: string | undefined;
  /**
   * Aborted when the job is cancelled (`AgentJobs.cancel`), fails its
   * deadline or is otherwise settled while it runs (#1222): at once in this
   * process, within `cancelCheckMs` in another. Pass it to whatever the job
   * waits on, an agent run (`agent.stream({ signal })`) above all.
   */
  readonly signal: AbortSignal;
  /**
   * The messages `AgentJobs.message` left for the job (#1222). `take()`
   * empties the inbox and answers them, oldest first. Hand it to
   * `agent.stream({ inbox: job.inbox })` and the run adds each message as a
   * user message before its next model call.
   */
  readonly inbox: AgentInbox;
  /**
   * What an earlier attempt saved with `checkpoint`, or `undefined` on a
   * first attempt. A job retried after a crash or a restart (the queue runs
   * it again) starts from here instead of from scratch.
   */
  readonly checkpointed: unknown;
  /**
   * Saves plain data for the next attempt to read as `checkpointed`, such as
   * the messages an agent run has finished so far (`onMessage`). Answers
   * false once the job is no longer running.
   */
  checkpoint(value: unknown): Promise<boolean>;
  /**
   * The attachments of the run that started the job: what the tool's
   * `ctx.attachments` was. Throws when that run had no attachment scope.
   */
  readonly attachments: JobAttachments;
  /** `generate`, with its usage counted on the job. See `ToolContext.generate`. */
  generate<O extends Schema<any>>(params: GenerateParams<O>): Promise<GenerateResult<Infer<O>>>;
  /** Renders an image and stores it under the run's attachments. Usage is counted on the job. */
  generateImage(model: ImageModel, params: JobGenerateImageParams): Promise<GeneratedAttachment>;
  /** Edits images (bytes or attachment ids) and stores the result. Usage is counted on the job. */
  editImage(model: ImageModel, params: JobEditImageParams): Promise<GeneratedAttachment>;
  /** What this attempt has spent so far. */
  readonly usage: Usage;
}

/**
 * Messages for a running agent, taken between its steps (#1222). See
 * `AgentStreamParams.inbox` and `AgentJobContext.inbox`.
 */
export interface AgentInbox {
  /** Empties the inbox and answers what was in it, oldest first. */
  take(): Promise<readonly string[]> | readonly string[];
}

/**
 * A queued job that settles a tool call (#461).
 *
 *     class RenderImagesJob extends AgentJob<{ pageId: number; prompts: string[] }, { made: number }> {
 *       static name = "RenderImagesJob";
 *       async run({ pageId, prompts }, job) {
 *         for (const prompt of prompts) await job.generateImage(model, { prompt });
 *         return { made: prompts.length };
 *       }
 *     }
 *
 * A gemi `Job`, so it gets the queue's leases, retries, backoff and dead
 * letters. Register it with the queue like any other job. What `run` returns
 * settles the tool call `ok`; a throw on the last attempt settles it `error`.
 * At least once: make `run` idempotent.
 *
 * Declare `run` as a method, not as an arrow-function field. Override
 * `onDeadletter` only with a call to `super.onDeadletter`, which is what fails
 * the job. `worker = true` is not supported. The queue hands `uniqueId`,
 * `throttle`, `concurrency`, `onFail` and `onDeadletter` the envelope
 * `{ jobId, args }`, not `args`.
 */
export abstract class AgentJob<Args = unknown, Output = unknown> extends Job {
  /** Phantom: the arguments' type. Never set. */
  declare readonly $args: Args;
  /** Phantom: the output's type. Never set. */
  declare readonly $output: Output;

  /**
   * Where the job's `attachments` records live. Set it to what the
   * controller's `attachments` is, as for the controller itself.
   */
  attachments: AttachmentStore = defaultAttachmentStore;
  /** Where the attachments' bytes live. Defaults to the app's `Storage`. */
  attachmentStorage: AttachmentStorage = Storage;
  /**
   * How often a running job reads its record to notice it was cancelled in
   * another process, in milliseconds (#1222). `0` turns it off; a cancel in
   * this process aborts `job.signal` at once either way.
   */
  cancelCheckMs = 5_000;

  abstract run(args: Args, job: AgentJobContext): Promise<Output> | Output;

  constructor() {
    super();
    // The queue calls `run(...payload)`, and the payload is the envelope. The
    // subclass's `run` is the job's body, so it is wrapped here, on the
    // instance: the queue sees a `run` that loads the record, runs the body
    // and settles the job, and the subclass writes only its work.
    const body = (this as any).run as (args: Args, job: AgentJobContext) => Promise<Output>;
    (this as any).run = (envelope: JobEnvelope) => this.$runEnvelope(envelope, body);
  }

  /**
   * Fails the job once the queue has given up on it: its last attempt threw,
   * it called `this.fail(error, { retry: false })`, or its process died on the
   * last attempt.
   */
  onDeadletter(error: Error, ..._args: any[]): void {
    const envelope = _args[0] as JobEnvelope | undefined;
    if (!envelope?.jobId) return;
    void settleOn(AgentJobs.store, envelope.jobId, { error }).catch((err) => {
      console.error(`Could not record the failure of background job ${envelope.jobId}.`, err);
    });
  }

  /** @internal The queue-facing `run`: see the constructor. */
  private async $runEnvelope(
    envelope: JobEnvelope,
    body: (args: Args, job: AgentJobContext) => Promise<Output>,
  ): Promise<Output | undefined> {
    const store = AgentJobs.store;
    const record = await store.get(envelope.jobId);
    // Settled already (the deadline passed, it was cancelled, or another
    // attempt finished it): nothing it produced would be kept, so the work is
    // not done again. A waiting job is queued only once it starts.
    if (!record || record.state !== "running") return undefined;

    const abort = new AbortController();
    runningHere.set(record.id, abort);
    const watch =
      this.cancelCheckMs > 0
        ? setInterval(() => {
            void store
              .get(record.id)
              .then((now) => {
                if (now && now.state !== "running" && !abort.signal.aborted) {
                  abort.abort(new ToolError("The background job was cancelled."));
                }
              })
              .catch(() => {});
          }, this.cancelCheckMs)
        : undefined;
    (watch as { unref?: () => void } | undefined)?.unref?.();

    const context = new JobContext(record, this, abort.signal);
    let output: Output;
    try {
      output = await body.call(this, envelope.args as Args, context);
    } catch (error) {
      await keepUsage(store, record.id, context.usage);
      // Cancelled or settled under it: the error is the abort, and retrying
      // would only meet a settled record.
      const now = await store.get(record.id).catch(() => null);
      if (abort.signal.aborted || (now && now.state !== "running")) return undefined;
      throw error;
    } finally {
      clearInterval(watch);
      if (runningHere.get(record.id) === abort) runningHere.delete(record.id);
    }
    if (this.$outcome) {
      // `this.release()` or `this.fail()`: the queue decides what happens next.
      await keepUsage(store, record.id, context.usage);
      return output;
    }
    await settleOn(store, record.id, { output, usage: context.usage });
    return output;
  }
}

/** Adds an attempt's spend to a job still running, so a retry does not lose it. */
async function keepUsage(store: AgentJobStore, id: string, usage: Usage): Promise<void> {
  if (usage.totalTokens === 0 && usage.inputTokens === 0 && usage.outputTokens === 0) return;
  const record = await store.get(id);
  if (!record) return;
  await store
    .transition(id, ANY_STATE, { usage: addUsage(record.usage ?? emptyUsage(), usage) })
    .catch(() => {});
}

class JobContext implements AgentJobContext {
  readonly id: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly owner: string | null;
  readonly summary: unknown;
  readonly after: readonly string[];
  readonly batch: string | undefined;
  readonly checkpointed: unknown;
  readonly inbox: AgentInbox;
  usage: Usage = emptyUsage();
  readonly attachments: JobAttachments;

  constructor(
    record: AgentJobRecord,
    job: AgentJob<any, any>,
    readonly signal: AbortSignal,
  ) {
    this.id = record.id;
    this.after = record.after ?? [];
    this.batch = record.batch;
    this.checkpointed = record.checkpoint;
    const store = AgentJobs.store;
    this.inbox = {
      take: async () => (store.takeInbox ? await store.takeInbox(record.id) : []),
    };
    this.threadId = record.threadId;
    this.toolCallId = record.toolCallId;
    this.toolName = record.toolName;
    this.owner = record.owner;
    this.summary = record.summary;
    const scoped = record.attachmentScope
      ? new ScopedAttachments(job.attachments, job.attachmentStorage, {
          key: record.attachmentScope,
        })
      : null;
    const scope = (): ScopedAttachments => {
      if (!scoped) {
        throw new InvalidAttachmentScopeError(
          "The run that started this job had no attachment scope, so the job cannot store or read files. See `attachmentScope()` on the controller.",
        );
      }
      return scoped;
    };
    this.attachments = {
      put: (blob, params = {}) => scope().put(blob, params),
      get: (id) => scope().get(id),
      read: (id) => scope().read(id),
      file: (id) => scope().file(id),
    };
  }

  async checkpoint(value: unknown): Promise<boolean> {
    return AgentJobs.store.transition(this.id, ["running"], {
      checkpoint: plainData(value, this),
    });
  }

  generate(params: GenerateParams<any>): Promise<any> {
    return generateWithin(params, {
      origin: { threadId: this.threadId, toolCallId: this.toolCallId, jobId: this.id },
      settled: (result) => {
        this.usage = addUsage(this.usage, result.usage);
      },
    });
  }

  async generateImage(
    model: ImageModel,
    params: JobGenerateImageParams,
  ): Promise<GeneratedAttachment> {
    const { name, ...settings } = params as JobGenerateImageParams & { name?: string };
    const image = await model.generate({ ...settings, signal: this.signal });
    return this.park(model, image, name);
  }

  async editImage(model: ImageModel, params: JobEditImageParams): Promise<GeneratedAttachment> {
    const { name, images, mask, ...settings } = params as JobEditImageParams & { name?: string };
    const asInput = async (input: ImageInput | string): Promise<ImageInput> =>
      typeof input === "string" ? await this.attachments.file(input) : input;
    const image = await model.edit({
      ...settings,
      images: (await Promise.all(images.map(asInput))) as [ImageInput, ...ImageInput[]],
      ...(mask ? { mask: await asInput(mask) } : {}),
      signal: this.signal,
    });
    return this.park(model, image, name);
  }

  private async park(
    model: ImageModel,
    image: { image: Blob; mimeType: string; size: string; usage: Usage },
    name: string | undefined,
  ): Promise<GeneratedAttachment> {
    // Counted before the store write, which may fail: the render was billed.
    this.usage = addUsage(this.usage, image.usage);
    const extension = image.mimeType === "image/jpeg" ? "jpg" : "png";
    const attachment = await this.attachments.put(image.image, {
      name: name ?? `${model.name}.${extension}`,
      mimeType: image.mimeType,
    });
    return { attachment, size: image.size, mimeType: image.mimeType, usage: image.usage };
  }
}

// --- batched settles ---------------------------------------------------------

type BatchGroup = {
  jobs: Map<string, AgentJobRecord>;
  /** When the oldest unreported settle arrived, for `maxDelayMs`. */
  first: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** A listener call is under way; `again` asks for another look after it. */
  busy: boolean;
  again: boolean;
};

/** `AgentJobs.onSettledBatch`'s state: settled jobs per key, waiting to be reported. */
class SettledBatcher {
  private groups = new Map<string, BatchGroup>();
  private stopped = false;
  private readonly delayMs: number;
  private readonly maxDelayMs: number;
  private readonly keyOf: (job: AgentJobRecord) => string;

  constructor(
    private readonly listener: AgentJobBatchListener,
    private readonly options: AgentJobBatchOptions,
  ) {
    this.delayMs = Math.max(0, options.delayMs ?? 1000);
    this.maxDelayMs = Math.max(this.delayMs, options.maxDelayMs ?? this.delayMs * 10);
    this.keyOf = options.key ?? ((job) => job.threadId);
  }

  add(record: AgentJobRecord): void {
    if (this.stopped) return;
    const key = this.keyOf(record);
    let group = this.groups.get(key);
    if (!group) {
      group = { jobs: new Map(), first: undefined, timer: undefined, busy: false, again: false };
      this.groups.set(key, group);
    }
    group.jobs.set(record.id, record);
    group.first ??= Date.now();
    this.schedule(key, false);
  }

  flush(key: string | undefined, now: boolean): void {
    for (const each of key === undefined ? [...this.groups.keys()] : [key]) {
      if (this.groups.has(each)) this.schedule(each, now);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const group of this.groups.values()) clearTimeout(group.timer);
    this.groups.clear();
  }

  private schedule(key: string, now: boolean): void {
    const group = this.groups.get(key);
    if (!group) return;
    if (group.busy) {
      group.again = true;
      return;
    }
    clearTimeout(group.timer);
    const cap =
      group.first === undefined ? this.delayMs : group.first + this.maxDelayMs - Date.now();
    const wait = now ? 0 : Math.max(0, Math.min(this.delayMs, cap));
    group.timer = setTimeout(() => void this.run(key), wait);
    (group.timer as { unref?: () => void }).unref?.();
  }

  private async run(key: string): Promise<void> {
    const group = this.groups.get(key);
    if (!group || this.stopped) return;
    group.timer = undefined;
    group.busy = true;
    try {
      for (;;) {
        group.again = false;
        const ready = await this.ready([...group.jobs.values()]);
        if (ready.length === 0) break;
        const held = this.options.hold ? await this.options.hold(ready, key) : false;
        if (held === true) break;
        if (typeof held === "number" && held > 0) {
          const later = setTimeout(() => this.flush(key, true), held);
          (later as { unref?: () => void }).unref?.();
          break;
        }
        for (const job of ready) group.jobs.delete(job.id);
        try {
          await this.listener(ready, key);
        } catch (error) {
          console.error(`An AgentJobs.onSettledBatch listener failed for ${key}.`, error);
        }
        if (this.stopped) return;
      }
    } catch (error) {
      console.error(`Could not report the settled background jobs of ${key}.`, error);
    } finally {
      group.busy = false;
      if (group.jobs.size === 0) {
        if (this.groups.get(key) === group) this.groups.delete(key);
      } else {
        group.first = undefined;
        if (group.again) this.schedule(key, false);
      }
    }
  }

  /**
   * The settled jobs that may be reported now: each without a batch, and each
   * whose batch has no other unsettled job that does not build on it.
   */
  private async ready(jobs: AgentJobRecord[]): Promise<AgentJobRecord[]> {
    const store = AgentJobs.store;
    const batches = new Map<string, Map<string, AgentJobRecord>>();
    const out: AgentJobRecord[] = [];
    // In the order they settled.
    for (const job of jobs) {
      if (job.batch === undefined || !store.listBatch) {
        out.push(job);
        continue;
      }
      let batch = batches.get(job.batch);
      if (!batch) {
        batch = new Map((await store.listBatch(job.batch)).map((record) => [record.id, record]));
        batches.set(job.batch, batch);
      }
      const members = batch;
      const needs = (record: AgentJobRecord, id: string, seen = new Set<string>()): boolean => {
        if (seen.has(record.id)) return false;
        seen.add(record.id);
        const after = record.after ?? [];
        return (
          after.includes(id) ||
          after.some((other) => {
            const next = members.get(other);
            return next !== undefined && needs(next, id, seen);
          })
        );
      };
      const blocked = [...members.values()].some(
        (other) => other.id !== job.id && !isSettled(other.state) && !needs(other, job.id),
      );
      if (!blocked) out.push(job);
    }
    return out;
  }
}
