# AI Background Jobs

A tool's `execute` has to finish inside its run, and a run is bounded by `maxRunDurationMs` (10 minutes by default) and by the life of the process that holds it. Work that takes longer, such as rendering a batch of images or waiting for a video provider, can be handed to a background job instead. The tool returns at once with a `running` result, the turn ends as usual, and the thread takes new turns while the job works. When the job settles, its output replaces the `running` result.

Background jobs need a threaded conversation (a turn with a `threadId`, through `AgentController`), because the result settles into the thread the server keeps.

## A tool that starts a job

Declare `async` on the tool and return what `ctx.jobs.start` answers:

```typescript
import { AgentJob, type AgentJobContext, AgentTool, ImageModel, s } from "gemi/ai";

declare const imageModel: ImageModel;

export class RenderImagesJob extends AgentJob<{ prompts: string[] }, { attachments: string[] }> {
  static name = "RenderImagesJob";

  async run({ prompts }: { prompts: string[] }, job: AgentJobContext) {
    const attachments: string[] = [];
    for (const prompt of prompts) {
      const { attachment } = await job.generateImage(imageModel, { prompt });
      attachments.push(attachment.id);
    }
    return { attachments };
  }
}

export const generateImages = AgentTool.create({
  name: "generateImages",
  description: "Render images for the page.",
  inputSchema: s.object({ prompts: s.array(s.string()) }),
  // The tool may go to the background, for at most deadlineMs.
  async: { deadlineMs: 15 * 60_000 },
  async execute({ prompts }, ctx) {
    return ctx.jobs.start(RenderImagesJob, { prompts }, {
      // What the model and the UI see while it runs. Plain data; keep it small.
      summary: { count: prompts.length },
    });
  },
});
```

Register the job with the queue like any other job (put it under `app/jobs`, or list it in `app/config/queue.ts`). See [Jobs & Queues](./jobs-and-queues.md).

What happens:

1. `ctx.jobs.start` writes a job record (`ajob_…`) and queues the job. It answers a `JobHandle`.
2. The tool returns the handle, so the call's result is `{ status: "running", job: { id, summary } }`. The model reads that the job started and is told not to start it again. The turn goes on and ends as usual.
3. The queue runs `RenderImagesJob.run`. What it returns settles the job `ok`. A throw on its last attempt (`maxAttempts`) settles it `error`.
4. The next time the controller loads the thread (the next turn, or `readThread`), the `running` result is replaced in place by the job's result: `{ status: "ok", output, job }` or `{ status: "error", error, job }`. The next turn also writes it back to the store.

The tool's output type is the job's output, so a client's tool shapes see the settled result. A settled output is checked against the tool's `outputSchema` when it has one; an output that does not match becomes an `error` result with code `invalid_tool_result`.

### Inside the job

`run(args, job)` gets the job's arguments and an `AgentJobContext`:

- `job.id`, `job.threadId`, `job.toolCallId`, `job.toolName`, `job.owner` (the `runOwner` of the run that started it) and `job.summary`.
- `job.attachments`: `get`, `read`, `file` and `put`, under the attachment scope of the run that started the job, so ids the tool could read are ids the job can read.
- `job.generate(...)`, `job.generateImage(model, params)` and `job.editImage(model, params)`: as on a tool's `ctx`, without `showModel` (there is no run to show the model anything). Their usage is counted on the job.
- `job.signal`: not aborted yet. Cancellation comes with a later release.

An `AgentJob` is a gemi `Job`, with its leases, retries, `backoff` and dead letters. The queue delivers at least once, so `run` must be idempotent: after a crash it runs again. Declare `run` as a method, not as an arrow-function field. The queue's own hooks (`uniqueId`, `throttle`, `concurrency`, `onFail`, `onDeadletter`) are handed the envelope `{ jobId, args }`; an `onDeadletter` override has to call `super.onDeadletter(...)`, which is what fails the job. `worker = true` is not supported.

The job's attachments go through `AgentJob.attachments` and `AgentJob.attachmentStorage`, which default to the same stores the controller defaults to. If your controller sets its own `attachments`, set the same on the job:

```typescript
import { AgentJob, type AgentJobContext, type AttachmentStore } from "gemi/ai";

declare const chatAttachments: AttachmentStore;

export class TidyJob extends AgentJob<{ id: string }, { ok: true }> {
  static name = "TidyJob";
  attachments = chatAttachments;

  async run({ id }: { id: string }, job: AgentJobContext) {
    await job.attachments.get(id);
    return { ok: true as const };
  }
}
```

### Errors

A job that throws a `ToolError` settles with that message, shown to the model. Any other error is logged in full, and the model is told only that the job failed, as for a tool that throws.

## Work something else completes: `ctx.jobs.track`

For work that a provider's webhook or a poller finishes, `ctx.jobs.track` records a job without queuing anything. Pass its id to whatever will report back, and settle it from there:

```typescript
import { AgentJobs, AgentTool, s } from "gemi/ai";

declare function startVideoRender(params: { prompt: string; callbackUrl: string }): Promise<void>;

export const renderVideo = AgentTool.create({
  name: "renderVideo",
  description: "Render a short video.",
  inputSchema: s.object({ prompt: s.string() }),
  async: { deadlineMs: 30 * 60_000 },
  async execute({ prompt }, ctx) {
    const handle = await ctx.jobs.track<{ url: string }>({ summary: { prompt } });
    await startVideoRender({ prompt, callbackUrl: `https://example.com/hooks/video/${handle.id}` });
    return handle;
  },
});

// In the webhook's controller:
export async function videoFinished(jobId: string, url: string) {
  await AgentJobs.settle(jobId, { output: { url } });
}
```

## Settling: `AgentJobs.settle` and `AgentJobs.fail`

`AgentJobs.settle(id, { output })`, `AgentJobs.settle(id, { error })` and `AgentJobs.fail(id, error)` are compare-and-set from `running`: the first one wins and answers `true`, and every later one answers `false` and changes nothing. A webhook, a poller and a deadline check can all race on one job. A job that has already failed stays failed: a late result is refused, so the model never sees a job turn from failed to done.

An error given as a string, a `ToolError` or an `AgentError`-like `{ code, message }` is shown to the model as it is. Any other `Error` is logged and replaced with a generic message.

`settle` also takes `usage`, which is added to the job's. A job's usage counts toward the turn that started it, and is on the settled result's `job.usage`.

## Where jobs are kept: `AgentJobs.use`

Job records live in an `AgentJobStore`. The store is process-wide, because the code that settles a job (a queue worker, a webhook) has no controller to read one from. Set it once at boot, in every process that starts or runs jobs:

```typescript
import { AgentJobs, MemoryAgentJobStore } from "gemi/ai";

AgentJobs.use(new MemoryAgentJobStore());
```

The default is a `MemoryAgentJobStore`. It is not durable: a restart loses every record, and it only works when the queue runs the jobs in the same process. A `running` result whose job the store no longer has becomes an `error` saying the result was lost and the work may have happened. An app with a jobs table of its own can implement `AgentJobStore` over it (`create`, `get`, `listForThread`, a compare-and-set `transition`, and `overdue`).

## Where a job cannot start

`ctx.jobs.start` and `ctx.jobs.track` throw, and the model reads the message as the tool's error, when:

- the turn is stateless (no `threadId`): a `JobsRequireThreadError` (`code: "jobs_require_thread"`);
- the tool is a sub-agent's (`ctx.runAgent`): also `JobsRequireThreadError`;
- the tool does not declare `async`;
- the tool call already started a job (one per call).

A tool re-entered after an escalation (`ctx.resumed`) gets the job it started the first time.

## Restarts and orphans

The work recovers through the queue: a job whose process died is claimed again once its lease runs out. If the run dies after `ctx.jobs.start` and before the `running` result reached the store, the job still runs and settles, but nothing in the thread points at it. The next turn on the thread marks it `orphaned` on its record (`AgentJobRecord.orphaned`).

## What does not change

`maxRunDurationMs`, a tool's `timeoutMs` and `maxSteps` still bound the run. A tool that returns a handle finishes its part of the run at once. The job's deadline (`deadlineAt` on its record, from `deadlineMs`) is recorded when it starts. Stopping a run does not stop the jobs it started.
