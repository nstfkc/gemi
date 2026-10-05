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

/** Every state, for a transition that does not change the state. */
const ANY_STATE: AgentJobState[] = ["running", "ok", "error"];

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
    return failed;
  },
};

/** The store's clock, or this process's for a store without one. */
export async function clockOf(store: AgentJobStore): Promise<number> {
  return store.now ? await store.now() : Date.now();
}

/** Fails a running job for its deadline. Compare-and-set: false when it had settled. */
export function expire(store: AgentJobStore, record: AgentJobRecord): Promise<boolean> {
  return store.transition(record.id, ["running"], {
    state: "error",
    error: {
      code: "timeout",
      message: `The background job for "${record.toolName}" did not finish before its deadline, so it was given up on. Its result, if it ever arrives, is ignored.`,
      toolCallId: record.toolCallId,
      retryable: true,
    },
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
  if ("error" in outcome) {
    return store.transition(id, ["running"], {
      state: "error",
      error: jobError(record, outcome.error),
      ...(usage ? { usage } : {}),
    });
  }
  return store.transition(id, ["running"], {
    state: "ok",
    output: plainData(outcome.output, record),
    ...(usage ? { usage } : {}),
  });
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
      const store = AgentJobs.store;
      // A tool re-entered after an escalation runs from the top again. The job
      // it started the first time is the one it gets.
      const existing = (await store.listForThread(threadId, { limit: 50 })).find(
        (record) => record.toolCallId === params.toolCallId,
      );
      if (existing) return handleOf(existing);

      const write = async () => {
        const record = await store.create({
          id: `ajob_${crypto.randomUUID()}`,
          threadId,
          runId: params.runId,
          toolCallId: params.toolCallId,
          toolName: params.toolName,
          owner: jobs.owner,
          job: job ? job.name : null,
          ...(options.summary !== undefined ? { summary: plainData(options.summary, params) } : {}),
          attachmentScope: params.attachments?.scopeKey ?? null,
          deadlineMs,
        });
        if (job) {
          try {
            await dispatchJob(job, { jobId: record.id, args });
          } catch (error) {
            // In a store transaction the record goes with the rollback.
            if (store.transaction) throw error;
            // Nothing will ever run it, so it is failed now rather than left to
            // reach its deadline, and the tool call reports the failure.
            await store
              .transition(record.id, ["running"], {
                state: "error",
                error: {
                  code: "tool_error",
                  message: `The background job for "${params.toolName}" could not be queued.`,
                  toolCallId: params.toolCallId,
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
  if (job.name === "unset" || !job.name) {
    throw new Error("Cannot start an AgentJob with no `static name`.");
  }
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
  /** Not aborted yet: cancellation comes with a later release (#461, phase 4). */
  readonly signal: AbortSignal;
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
    // Settled already (the deadline passed, or another attempt finished it):
    // nothing it produced would be kept, so the work is not done again.
    if (!record || record.state !== "running") return undefined;

    const context = new JobContext(record, this);
    let output: Output;
    try {
      output = await body.call(this, envelope.args as Args, context);
    } catch (error) {
      await keepUsage(store, record.id, context.usage);
      throw error;
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
  readonly signal = new AbortController().signal;
  usage: Usage = emptyUsage();
  readonly attachments: JobAttachments;

  constructor(record: AgentJobRecord, job: AgentJob<any, any>) {
    this.id = record.id;
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
