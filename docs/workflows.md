# Workflows

A **workflow** is a multi-step process that survives restarts and deploys. It can sleep for days, wait for a person to act, fan out a batch of jobs and wait for them, retry each step on its own schedule, and be cancelled with a cleanup step. While it sleeps or waits, it holds no process.

Use a job for one piece of work. Use a workflow when the work has stages whose order and results matter, for example: import a site, wait for the user to choose pages, charge once, build every page, then report.

Workflows run on the [queue](./jobs-and-queues.md). Use [`driver: "database"`](./jobs-and-queues.md#the-database-driver) in production: with the default memory driver, a workflow is lost when the process exits, like any other queued job.

## Defining a workflow

A workflow is a class extending `Workflow` with a **static `name`** and a `run` method. `run` gets a `Step` first, then the arguments the workflow was started with. Put workflows in `app/workflows/`; the directory is read at boot.

```typescript
// app/workflows/ImportSiteWorkflow.ts
import { type Step, Workflow } from "gemi/services";
import { BuildPageJob } from "@/app/jobs/BuildPageJob";

export class ImportSiteWorkflow extends Workflow {
  static name = "ImportSiteWorkflow";

  async run(step: Step, importId: string) {
    const pages = await step.run("discover", () => crawl(importId));

    // Wait (for up to a week) until the user picks pages in the wizard.
    const chosen = await step.waitFor<string[]>("pages-chosen", { timeout: "7d" });

    // Must not happen twice: one attempt, and an idempotency key for the provider.
    await step.run("charge", (ctx) => charge(importId, chosen, ctx.idempotencyKey), {
      attempts: 1,
    });

    const builds = await step.batch(
      "build",
      BuildPageJob,
      chosen.map((pageId) => [pageId, importId] as const),
      { allowFailures: true },
    );

    await step.sleep("settle", "30s");
    return step.run("report", () => finish(importId, pages.length, builds.failedJobIds));
  }

  async onCancel(step: Step, importId: string) {
    await step.run("refund", () => refundUnbuilt(importId));
  }
}
```

The static `name` is required for the same reason a job's is: workflows are stored under it, and a production build renames classes. Discovery warns about a workflow without one. To list workflows yourself instead of discovering them, set `workflows: [...]` in `app/config/queue.ts` (`workflowsDir` moves the directory).

## Starting, signalling, inspecting, cancelling

```typescript
import { Workflow } from "gemi/services";
import { ImportSiteWorkflow } from "@/app/workflows/ImportSiteWorkflow";

const id = await ImportSiteWorkflow.start(importId); // typed against run's arguments
await ImportSiteWorkflow.signal(id, "pages-chosen", ["p1", "p3"]); // resumes step.waitFor
const status = await Workflow.find(id);
await Workflow.cancel(id);
```

- `start(...args)` records the workflow and its first tick in one write, and resolves to the workflow's id. Inside an ORM transaction it belongs to the transaction, like a [dispatch](./jobs-and-queues.md#dispatching-inside-a-transaction): it is written with the transaction's rows on Postgres and MySQL, held until the commit otherwise, and dropped if the transaction rolls back.
- `signal(id, key, payload)` delivers `payload` to `step.waitFor(key)` and resolves to `true` if it was taken. It is `false` for an unknown or ended workflow, one being cancelled, and a key that was already signalled. A signal that arrives before the workflow reaches its `waitFor` is kept until it does.
- `find(id)` resolves to the status below, or `null`.
- `cancel(id)` resolves to `true` if it cancelled a workflow that had not ended. See [Cancelling](#cancelling).

`signal`, `find` and `cancel` work from `Workflow` or any subclass.

## How a workflow runs

This is the one thing to understand before writing a workflow.

A workflow advances in **passes**. Each pass calls `run` **from the top**, inside an internal queue job (the *tick*). A step whose key already has a stored result returns that result at once, without running. The first step without a result runs, and its result is stored before the code continues. A step that cannot finish now (a sleep, a wait for a signal, a batch, or a retry with a delay) ends the pass, and a later tick runs `run` from the top again.

So:

- **Code outside `step.*` runs again on every pass.** Keep it cheap and deterministic: given the same step results, it must make the same calls in the same order. Anything with a side effect (an email, a write, an API call), anything slow, and anything random or time-dependent (`Date.now()`, `crypto.randomUUID()`) goes inside `step.run`, so its result is stored once and replayed.
- **A step key is the step's identity.** Keys must be unique within the workflow (two steps with one key fail the workflow) and the same on every pass. Build them from data that does not change, for example `` `page:${page.id}` `` in a loop.
- **Changing a workflow between deploys.** Adding or removing steps is safe for workflows already running: a new step runs when a pass reaches it, and a removed step's stored result is ignored. A renamed step runs again. Using one key for a different kind of step (a `sleep` that becomes a `run`) fails the workflow.
- **Values are stored as JSON**, at most 256 KB each, so a step returns what `JSON.stringify` makes of its value, on the first pass too: a `Date` comes back as a string, `undefined` stays `undefined`. Store a large result elsewhere and return its id.
- **At least once.** If a process dies after a step's side effect and before its result is stored, the step runs again on the next pass. The same is true of jobs. Use `ctx.idempotencyKey` for anything that must not happen twice, or `attempts: 1`.

Ticks are ordinary queue jobs, so a workflow gets the queue's leases, heartbeats and crash recovery: a pass whose process dies is claimed again once its lease runs out, and continues after the last stored step. Two passes of one workflow never run at the same time, on any number of processes.

## Steps

### `step.run(key, fn, options?)`

Runs `fn` once and returns its result. `fn` receives a context:

| Field | Description |
| --- | --- |
| `idempotencyKey` | `<workflow id>:<key>`, the same on every attempt of this step. Pass it to a payment provider, for example. |
| `attempt` | Which attempt this is, from 1. |
| `signal` | An `AbortSignal`, aborted when the step's `timeout` passes or the workflow is cancelled. |

| Option | Default | Description |
| --- | --- | --- |
| `attempts` | `3` | Attempts in total, counting the first. |
| `backoff` | `0` | Milliseconds before each retry, as [`Job.backoff`](./jobs-and-queues.md): a number, or one per retry with the last repeated. A retry with a delay suspends the workflow until it is due. |
| `timeout` | none | How long one attempt may take, as a duration. Past it the attempt fails and `ctx.signal` is aborted. |

A step retries on its own, without restarting the workflow. After its last attempt it fails, and `step.run` throws a `StepFailedError` (with `.step`, the key). The workflow may catch it and go on; uncaught, it fails the workflow. A failed step throws the same error on every later pass. An attempt whose process died counts as an attempt, so a step that crashes its process cannot loop forever.

When a timeout or a cancel aborts `ctx.signal`, the workflow stops waiting for `fn` at once. JavaScript cannot stop a running function, so `fn` may keep running in the background unless it listens to `ctx.signal`.

### `step.sleep(key, duration)`

Suspends the workflow for `duration`: milliseconds, or a string such as `"30s"`, `"5m"`, `"2h"`, `"7d"` or `"1w"`. The wake-up is a delayed tick in the queue, so a sleeping workflow holds no process and survives deploys. The sleep ends at a fixed time, set the first time the step is reached.

### `step.waitFor(key, options?)`

Suspends the workflow until `Workflow.signal(id, key, payload)`, and returns the payload. With `timeout`, it throws a `WaitTimeoutError` once that has passed without a signal. Each key takes one signal.

```typescript
try {
  const approval = await step.waitFor<{ approved: boolean }>("approval", { timeout: "3d" });
} catch (error) {
  if (!(error instanceof WaitTimeoutError)) throw error;
  await step.run("remind", () => sendReminder(orderId));
}
```

In this version a wait resumes only on `signal`. Resuming on a gemi `Event` is planned.

### `step.batch(key, Job, tuples, options?)`

Dispatches one job per argument tuple as a [batch](./jobs-and-queues.md#batches), suspends the workflow until every job has ended, and returns the batch's `BatchStatus`. The tuples are typed against the job's `run`, as in `dispatchBatch`.

The step is recorded and the batch dispatched in the same write, so a crash between the two cannot dispatch it twice. The batch's `finally` wakes the workflow.

| Option | Description |
| --- | --- |
| `allowFailures` | Default `false`: the first dead-lettered job cancels the batch, and `step.batch` throws a `StepFailedError` whose `.batch` is the status. With `true`, `step.batch` returns the status, failed jobs and all (`failedJobIds`). |
| `name` | A label kept with the batch. Default `workflow:<id>:<key>`. |

The job class has to be registered with the queue, and [the batch limits](./jobs-and-queues.md#limits) apply: no worker jobs, no unique jobs.

### `step.progress(value)`

Sets the workflow's `progress`, from 0 to 1. It is not a step: it writes on every pass that reaches it. A completed workflow's progress is 1.

### Parallel steps

Steps can run side by side with `Promise.all`, each with its own key:

```typescript
const [profile, invoices] = await Promise.all([
  step.run("profile", () => fetchProfile(userId)),
  step.run("invoices", () => fetchInvoices(userId)),
]);
```

If one of them suspends the workflow (a sleep, say), the others still finish and store their results in that pass.

## Cancelling

`Workflow.cancel(id)` marks the workflow `cancelling` and then:

- cancels a running `step.batch` (its waiting jobs never run; see [cancelling a batch](./jobs-and-queues.md#cancelling--jobcancelbatchid)),
- aborts a running `step.run` through `ctx.signal` (checked about once a second while it runs),
- starts no new step of `run`,
- runs `onCancel(step, ...args)` once, in place of `run`, with the same arguments.

`onCancel` is where you undo what the steps did. Its steps are stored like `run`'s (give them their own keys), so it can retry, sleep or wait too. When it returns, the workflow is `cancelled`. If it throws, the workflow is still `cancelled`, with the error in `error`.

## Status — `Workflow.find(id)`

| Field | Description |
| --- | --- |
| `id`, `name`, `args` | The workflow's id, its class's name and the arguments it was started with. |
| `status` | `running`, `sleeping` (a sleep or a retry's delay), `waiting` (a signal or a batch), `cancelling`, or one of the final `completed`, `failed`, `cancelled`. |
| `currentStep` | The key of the step it is on, or `null`. |
| `progress` | 0 to 1: what `step.progress` set, and 1 once completed. |
| `result` | What `run` returned, once completed. |
| `error` | Why it failed, or why `onCancel` failed. |
| `steps` | Every step recorded so far, in the order first reached: `key`, `status`, `attempt`, `error`, `batchId`, `wakeAt`, `startedAt`, `finishedAt`, and for a batch step its `progress`. |
| `createdAt`, `updatedAt` | Epoch milliseconds. |

Step outputs are not in the status. Return what a caller needs from `run`.

## The workflow tables

With `driver: "database"`, workflows are kept in two tables beside `gemi_jobs`. They also need [the batch columns](./jobs-and-queues.md#the-batches-table) if you use `step.batch`. Add the models and run `prisma migrate dev`:

```prisma
model GemiWorkflow {
  id          String  @id
  name        String
  args        String
  status      String
  currentStep String? @map("current_step")
  progress    Float   @default(0)
  result      String?
  error       String?
  wakeAt      BigInt? @map("wake_at")
  lockedBy    String? @map("locked_by")
  lockedUntil BigInt? @map("locked_until")
  retick      Int     @default(0)
  createdAt   BigInt  @map("created_at")
  updatedAt   BigInt  @map("updated_at")

  @@index([status])
  @@map("gemi_workflows")
}

model GemiWorkflowStep {
  workflowId String  @map("workflow_id")
  key        String
  status     String
  attempt    Int     @default(0)
  output     String?
  error      String?
  batchId    String? @map("batch_id")
  wakeAt     BigInt? @map("wake_at")
  startedAt  BigInt? @map("started_at")
  finishedAt BigInt? @map("finished_at")
  createdAt  BigInt  @map("created_at")
  updatedAt  BigInt  @map("updated_at")

  @@id([workflowId, key])
  @@map("gemi_workflow_steps")
}
```

On MySQL, add `@db.LongText` to `args`, `result` and `error` of `GemiWorkflow`, and to `output` and `error` of `GemiWorkflowStep`. Without Prisma, `await driver.createTable()` creates both tables (`IF NOT EXISTS`). Until they exist, everything else works and `start` rejects with an error that names what is missing.

A driver on another jobs table keeps workflows in `<table>_workflows` and `<table>_workflow_steps`, or in the tables named by the `workflowTable` and `workflowStepTable` options. Ended workflows are kept until `driver.workflowStore().prune(olderThanMs)` deletes them with their steps, for example from a cron job. The memory driver keeps ended workflows for a day.

A custom queue driver supports workflows by implementing `workflowStore()` (see `WorkflowStore`) and the batch methods.

## Limits

- **No determinism check beyond keys.** gemi checks that keys are unique and that a key keeps its kind of step. It cannot check that code outside the steps is deterministic; that is up to the workflow.
- **One signal per key.** To receive several events, wait on keys that include a counter or an id.
- **No `step.waitFor` on gemi Events yet**, only `signal`.
- **Workflows cannot be restarted** once they have failed. Start a new one.
