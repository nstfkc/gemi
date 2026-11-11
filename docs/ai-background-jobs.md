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
  // The tool may go to the background. A job still running after deadlineMs fails with code "timeout".
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
- `job.signal`: aborted when the job is cancelled, misses its deadline or is otherwise settled while it runs. See [Cancelling a job](#cancelling-a-job).
- `job.inbox`, `job.checkpoint(value)` and `job.checkpointed`: see [Messages for a running job](#messages-for-a-running-job) and [Checkpoints](#checkpoints).
- `job.after` and `job.batch`: the jobs it started after, and its batch.

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

`AgentJobs.settle(id, { output })`, `AgentJobs.settle(id, { error })` and `AgentJobs.fail(id, error)` are compare-and-set from `running`: the first one wins and answers `true`, and every later one answers `false` and changes nothing. A webhook, a poller and the deadline sweep can all race on one job. A job that has already failed (for example by its deadline) stays failed: a late result is refused, so the model never sees a job turn from failed to done.

An error given as a string, a `ToolError` or an `AgentError`-like `{ code, message }` is shown to the model as it is. Any other `Error` is logged and replaced with a generic message.

`settle` also takes `usage`, which is added to the job's. A job's usage counts toward the turn that started it, and is on the settled result's `job.usage`.

## Continuing the thread when a job settles

A settled job reaches the thread the next time the controller loads it, which is usually the person's next message. To have the agent react as soon as the work is done ("the video is ready"), listen with `AgentJobs.onSettled` and start a turn:

```typescript
import { AgentJobs } from "gemi/ai";
import { ChatController } from "@/app/http/controllers/ChatController";

declare function userForOwner(owner: string | null): Promise<unknown>;

// At boot, in every process that settles jobs.
AgentJobs.onSettled(async (job) => {
  await ChatController.startTurn({
    threadId: job.threadId,
    user: await userForOwner(job.owner), // job.owner is the run's `runOwner`
    ifBusy: "queue",                     // don't cut off an answer being read
  });
});
```

The listener gets the job's record as it settled: `state` is `"ok"` (with `output`) or `"error"` (with `error`; a missed deadline has `error.code` `"timeout"`), with `threadId`, `toolName`, `owner` and `summary`. It is called once per job, by whichever settle wins: `settle` and `fail`, an `AgentJob`'s result or its dead letter, the deadline sweep, and an overdue job failed when a thread is loaded. A job that could not be queued is not reported: its tool call fails in the turn that started it. `onSettled` answers a function that removes the listener.

It runs in the process that settled the job, which is often a queue worker or the one that took a webhook, so register it at boot wherever jobs settle (as for `AgentJobs.use`). The turn it starts runs in that process too (see [Where the run lives](./ai-server-turns.md#where-the-run-lives)). Settling does not wait for listeners, and a listener that throws is logged, not thrown into the settle. Several jobs settling together start one turn each, in order; batch them in the listener if one turn should report them all.

## Jobs that coordinate

An agent that hands out work, such as a lead that assigns tasks to workers, needs more than one job per tool call: some tasks wait for others, a running task gets more to do, a task gets stopped, and the lead is woken once for work that ends close together. The pieces below cover that. They need a store with the methods for them; `MemoryAgentJobStore` has them all, and `DatabaseAgentJobStore` needs [five more columns](#the-columns-for-coordination).

### Starting jobs from server code: `AgentJobs.start`

`ctx.jobs.start` binds a job to the tool call that started it. `AgentJobs.start` starts one from anywhere, with no tool call: from inside a tool that hands out several tasks at once, from a webhook, or from a cron job.

```typescript
import { AgentJob, type AgentJobContext, AgentJobs } from "gemi/ai";

export class BuildJob extends AgentJob<{ task: string }, { report: string }> {
  static name = "BuildJob";

  async run({ task }: { task: string }, job: AgentJobContext) {
    return { report: `Built ${task} (${job.id}).` };
  }
}

export async function assign(threadId: string) {
  const batch = crypto.randomUUID();
  const data = await AgentJobs.start(BuildJob, { task: "the data" }, { threadId, batch });
  const pages = await AgentJobs.start(
    BuildJob,
    { task: "the pages" },
    { threadId, batch, after: [data.id], name: "pages" },
  );
  return { data: data.id, pages: pages.id };
}
```

The options are `ctx.jobs.start`'s (`summary`, `deadlineMs`, `after`, `batch`) plus `threadId` (the thread whose `<jobs>` block lists it), `owner`, `name` (what the block and the record call it, by default the class's name) and `attachmentScope`. Its record has `toolCallId` and `runId` `""`, since no tool result points at it: read its outcome from the record (`AgentJobs.get`), from `onSettled` or from `onSettledBatch`. `AgentJobs.track(options)` records a job that something else settles, as `ctx.jobs.track` does.

### Dependencies: `after`

A job started with `after: [ids]` is `waiting`, and is not queued, until every job it names has settled `ok`. Then it starts, and its deadline counts from then. When one of them fails or is cancelled, the waiting job is cancelled too, with `error.code` `"dependency_failed"` or `"cancelled"`, and so are the jobs that wait for it in turn. A dependency that doesn't exist or has already failed is refused when the job is started. `after` works on `ctx.jobs.start` too; a tracked job cannot wait.

The settle that ends a dependency starts the jobs waiting for it, in the process that settled it. If that process dies in between, `AgentJobs.sweep()` (run by `AgentJobDeadlineSweep` every minute) starts them. A waiting job is listed in the `<jobs>` block with the jobs it waits for.

### Cancelling a job

```typescript
import { AgentJobs } from "gemi/ai";

export async function stop(jobId: string) {
  // false once it has settled
  return AgentJobs.cancel(jobId, { reason: "The user stopped it." });
}
```

`AgentJobs.cancel(id, { reason, silent })` settles a waiting or running job `error` with code `"cancelled"`, and cancels the jobs waiting for it. A running `AgentJob` sees `job.signal` abort: at once in the process that cancels it, and within `cancelCheckMs` (5 seconds by default; `0` turns the check off) in another, by reading its record. Pass the signal on to the work, such as `agent.stream({ signal: job.signal })`. What the job already changed stays, and what it returns afterwards is dropped; the queue does not retry it. `silent: true` keeps the cancel, and the cancels it causes, from `onSettled` listeners, for a caller that tells the user itself.

The same abort happens when the deadline sweep fails a running job.

### Messages for a running job

`AgentJobs.message(id, text)` leaves a message for a waiting or running job, and answers `false` once the job has settled. The job takes its messages with `job.inbox.take()`. Handed to an agent run, the run takes them before each model call and adds each as a user message (reported to `onMessage`, and put on the stream as a `message` frame), so the model reads it at its next step:

```typescript
import { AgentJob, type AgentJobContext, type AgentProvider, Agent } from "gemi/ai";

declare const provider: AgentProvider;
const worker = Agent.create({ name: "worker", provider });

export class WorkerJob extends AgentJob<{ task: string }, { report: string }> {
  static name = "WorkerJob";

  async run({ task }: { task: string }, job: AgentJobContext) {
    const result = await worker
      .stream({ messages: [], turn: { text: task }, inbox: job.inbox, signal: job.signal })
      .result();
    return { report: result.text };
  }
}
```

A waiting job gets its messages when it starts. A message that arrives after the run's last model call is not acted on: it stays in the inbox, and the settled record lists it (`inbox`), so whoever reads the report can see what the job never did.

### Checkpoints

The queue runs a job again after a crash or a restart. `job.checkpoint(value)` saves plain data on the record, and the next attempt reads it as `job.checkpointed` (`undefined` on a first attempt), so it can go on from there rather than start over. An agent run can checkpoint the messages it has finished, from `onMessage`, and start the next attempt from them.

### Reports in batches: `AgentJobs.onSettledBatch`

`onSettled` calls its listener once per job. A lead woken once per job ends up taking a turn for each. `onSettledBatch` reports jobs that end close together in one call:

```typescript
import { AgentJobs } from "gemi/ai";
import { ChatController } from "@/app/http/controllers/ChatController";

declare function userForOwner(owner: string | null): Promise<unknown>;
declare function questionOpen(threadId: string): boolean;

const subscription = AgentJobs.onSettledBatch(
  async (jobs, threadId) => {
    await ChatController.startTurn({
      threadId,
      user: await userForOwner(jobs[0]!.owner),
      ifBusy: "queue",
      event: { name: "work-settled", data: { jobs: jobs.map(({ id, state, output, error }) => ({ id, state, output, error })) } },
    });
  },
  { delayMs: 1500, hold: (_jobs, threadId) => (questionOpen(threadId) ? 10_000 : false) },
);

// When the person answers: report what was held.
export const answered = (threadId: string) => subscription.flush(threadId, { now: true });
```

- Jobs are grouped by `key` (`job.threadId` by default), and a group is reported `delayMs` (1 second by default) after its latest settle, and at most `maxDelayMs` (10 × `delayMs`) after its first.
- A job started with a `batch` is reported once every other unsettled job of its batch builds on it (lists it in `after`, directly or through another job). Jobs started together are reported together, and a report never comes before the work it would mention.
- `hold(jobs, key)` keeps the ready reports back: `true` until the next settle under the key or a `flush(key)`, a number of milliseconds to look again after, `false` to report now.
- One listener call per key at a time; jobs that settle meanwhile go in the next call. A job cancelled with `silent` is not reported.
- It hears the settles of its own process, like `onSettled`. The returned function removes it; `flush(key?, { now })` looks at a key (or every key) again.

## Where jobs are kept: `AgentJobs.use`

Job records live in an `AgentJobStore`. The store is process-wide, because the code that settles a job (a queue worker, a webhook, the deadline sweep) has no controller to read one from. Set it once at boot, in every process that starts or runs jobs:

```typescript
import { AgentJobs, MemoryAgentJobStore } from "gemi/ai";

AgentJobs.use(new MemoryAgentJobStore());
```

The default is a `MemoryAgentJobStore`. It is not durable: a restart loses every record, and it only works when the queue runs the jobs in the same process. A `running` result whose job the store no longer has becomes an `error` saying the result was lost and the work may have happened. An app with a jobs table of its own can implement `AgentJobStore` over it (`create`, `get`, `listForThread`, a compare-and-set `transition`, `overdue`, and optionally `now` and `transaction`).

### `DatabaseAgentJobStore`

For production, keep jobs in your database. It is opt-in, like the agent store. Set it in a service provider, which every process (servers and `gemi queue:work` workers) boots:

```typescript
// app/providers/AgentJobsServiceProvider.ts
import { AgentJobs, DatabaseAgentJobStore } from "gemi/ai";
import { DatabaseManager } from "gemi/database";
import { ServiceProvider } from "gemi/support";

export default class AgentJobsServiceProvider extends ServiceProvider {
  boot() {
    AgentJobs.use(new DatabaseAgentJobStore(this.app.make(DatabaseManager).connection()));
  }
}
```

It keeps jobs in a `gemi_agent_jobs` table and is written for SQLite, Postgres, and MySQL 8 or MariaDB 10.6+, in raw SQL like the [database queue driver](./jobs-and-queues.md#the-database-driver). The table is yours to create. With Prisma, add this model to `schema.prisma` and run `prisma migrate dev`:

```prisma
model GemiAgentJob {
  id              String  @id
  threadId        String  @map("thread_id")
  runId           String  @map("run_id")
  toolCallId      String  @map("tool_call_id")
  toolName        String  @map("tool_name")
  owner           String?
  job             String?
  summary         String?
  state           String
  output          String?
  error           String?
  usage           String?
  orphaned        Int     @default(0)
  attachmentScope String? @map("attachment_scope")
  createdAt       BigInt  @map("created_at")
  updatedAt       BigInt  @map("updated_at")
  deadlineAt      BigInt  @map("deadline_at")
  settledAt       BigInt? @map("settled_at")
  afterJobs       String? @map("after_jobs")
  batchKey        String? @map("batch_key")
  queued          String?
  inbox           String?
  jobCheckpoint   String? @map("job_checkpoint")

  @@index([threadId, createdAt])
  @@index([state, deadlineAt])
  @@map("gemi_agent_jobs")
}
```

On MySQL, add `@db.LongText` to `summary`, `output`, `error`, `usage`, `afterJobs`, `queued`, `inbox` and `jobCheckpoint`.

#### The columns for coordination

The last five columns (`after_jobs` to `job_checkpoint`) came with [jobs that coordinate](#jobs-that-coordinate). A table made without them works for everything else; starting a job with `after` or `batch`, `AgentJobs.message` and `job.checkpoint` throw an error naming the columns until they exist. Add them to the model and migrate. `createTable()` creates them on a new table only. Without Prisma, `await store.createTable()` creates the same table and indexes if they do not exist. `new DatabaseAgentJobStore(connection, { table })` picks another table name.

How it behaves:

- **Compare-and-set.** A settle is `UPDATE … WHERE id = ? AND state IN (…)`, so two instances settling one job cannot both win.
- **Time.** Times are epoch milliseconds from the database's clock, so the deadline sweep on any instance agrees on when a job is overdue.
- **Start in one transaction.** `ctx.jobs.start` writes the record and queues the job inside a transaction on the store's connection. On Postgres and MySQL, with the database queue driver on the same connection, both rows commit together or neither does. With another queue, the dispatch waits for the commit (see [Dispatching inside a transaction](./jobs-and-queues.md#dispatching-inside-a-transaction)).
- **Pruning.** Settled records stay until you remove them: `store.prune(olderThanMs)` deletes jobs settled longer ago than that, never running ones. Call it from a cron job. A settled result is written into the thread on the next turn, so an old record is only history.

## Deadlines

Every job has a deadline, `deadlineMs` after it started (from `ctx.jobs.start`'s options, else the tool's `async.deadlineMs`, else an hour). A job still running then is failed with code `"timeout"`, and a result that arrives later is refused. The queue worker is not stopped; what it returns afterwards is dropped.

Two things enforce it:

- **The sweep.** `AgentJobs.sweep()` fails every overdue job, and `AgentJobDeadlineSweep` runs it every minute. Schedule it by exporting it from a file under `app/cron`:

  ```typescript
  // app/cron/agentJobs.ts
  export { AgentJobDeadlineSweep } from "gemi/ai";
  ```

  It is safe on every instance at once, since each job is failed by compare-and-set.
- **A lazy pass.** When the controller loads a thread (each turn, and `readThread`), it fails that thread's overdue jobs first. An app without cron still sees a job time out, the next time someone opens the conversation.

## The `<jobs>` block

On a thread with background jobs, the controller adds a `<jobs>` block to the system prompt each turn. It lists the thread's jobs (at most 20 by default), running ones first and then the newest settled, each with its id, tool, state, time and summary:

```text
<jobs>
Background jobs that tools started in this conversation, running ones first. ...
- ajob_1b2… (generateImages); running since 2026-10-05T12:00:03Z; summary: {"count":3}
- ajob_9f0… (generateImages); finished at 2026-10-05T11:52:40Z; summary: {"count":2}
</jobs>
```

The history already shows each job's call and its result. The block puts them in one place, so a model asked again for the same work sees that a job for it is running rather than starting another, and it shows a job whose tool result never reached the thread (an orphan). Times are absolute rather than ages, so the block is the same text from one turn to the next until a job starts or settles, and the prompt cache holds in between.

Bound it, or turn it off, on the agent:

```typescript
import { Agent, type AgentProvider } from "gemi/ai";

declare const provider: AgentProvider;

export const builder = Agent.create({
  name: "builder",
  provider,
  jobs: { contextBlock: { max: 8 } }, // or contextBlock: false
});
```

## Where a job cannot start

`ctx.jobs.start` and `ctx.jobs.track` throw, and the model reads the message as the tool's error, when:

- the turn is stateless (no `threadId`): a `JobsRequireThreadError` (`code: "jobs_require_thread"`);
- the tool is a sub-agent's (`ctx.runAgent`): also `JobsRequireThreadError`;
- the tool does not declare `async`;
- the tool call already started a job (one per call).

A tool re-entered after an escalation (`ctx.resumed`) gets the job it started the first time.

## Restarts and orphans

The work recovers through the queue: a job whose process died is claimed again once its lease runs out, and with `DatabaseAgentJobStore` its record survives the restart too. If the run dies after `ctx.jobs.start` and before the `running` result reached the store, the job still runs and settles, but nothing in the thread points at it. The next turn on the thread marks it `orphaned` on its record (`AgentJobRecord.orphaned`).

## What does not change

`maxRunDurationMs`, a tool's `timeoutMs` and `maxSteps` still bound the run. A tool that returns a handle finishes its part of the run at once, and the job's deadline bounds the job. Stopping a run does not stop the jobs it started: cancel them with `AgentJobs.cancel`.
