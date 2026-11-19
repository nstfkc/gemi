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

## Starting, signalling, inspecting, pausing, cancelling

```typescript
import { Workflow } from "gemi/services";
import { ImportSiteWorkflow } from "@/app/workflows/ImportSiteWorkflow";

const id = await ImportSiteWorkflow.start(importId); // typed against run's arguments
await ImportSiteWorkflow.signal(id, "pages-chosen", ["p1", "p3"]); // resumes step.waitFor
const status = await Workflow.find(id);
await Workflow.pause(id); // and Workflow.resume(id)
await Workflow.cancel(id);
```

- `start(...args)` records the workflow and its first tick in one write, and resolves to the workflow's id. Inside an ORM transaction it belongs to the transaction, like a [dispatch](./jobs-and-queues.md#dispatching-inside-a-transaction): it is written with the transaction's rows on Postgres and MySQL, held until the commit otherwise, and dropped if the transaction rolls back.
- `signal(id, key, payload)` delivers `payload` to `step.waitFor(key)` and resolves to `true` if it was taken. It is `false` for an unknown or ended workflow, one being cancelled, and a key that was already signalled. A signal that arrives before the workflow reaches its `waitFor` is kept until it does.
- `find(id)` resolves to the status below, or `null`.
- `pause(id)` and `resume(id)` resolve to `true` if they paused a workflow that had not ended, or resumed a paused one. See [Pausing](#pausing).
- `cancel(id)` resolves to `true` if it cancelled a workflow that had not ended. See [Cancelling](#cancelling).

`signal`, `find`, `pause`, `resume` and `cancel` work from `Workflow` or any subclass.

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

### `step.each(key, options, fn)`: long lists, item by item

Works through a list of `count` items one at a time (or `concurrency` at once) and returns a summary once every item has ended. A **transformer**, `item(index)`, produces the input for each index when its turn comes, so the list is never held in memory, and `fn` handles that input. Use it for imports, a picture generated per item, or a digest sent per user: work where a list is too long to do in one go, where the user wants to see it move, and where load must stay low.

```typescript
// app/workflows/ImportProductsWorkflow.ts
import { type Step, Workflow } from "gemi/services";

export class ImportProductsWorkflow extends Workflow {
  static name = "ImportProductsWorkflow";

  async run(step: Step, importId: string) {
    const count = await step.run("count", () => ImportRow.count({ where: { importId } }));

    const summary = await step.each(
      "rows",
      {
        count,
        // The transformer: index → input. Read it from somewhere stable.
        item: (index) => ImportRow.findFirst({ where: { importId, position: index } }),
        key: (row) => row!.sku, // the item key, part of ctx.idempotencyKey
        concurrency: 4,
        attempts: 3,
        backoff: [1_000, 10_000],
      },
      async (row, ctx) => {
        if (!row?.name) ctx.skip("no name", { line: row?.line });
        await createProduct(row!, { idempotencyKey: ctx.idempotencyKey, signal: ctx.signal });
      },
    );

    // { total, done, succeeded, skipped, failed, problems, moreProblems }
    return step.run("report", () => saveReport(importId, summary));
  }
}
```

How it runs:

- **A cursor, not a step per item.** The step row keeps the next index to start and the counts. Each item that is in flight, waiting for a retry, failed or skipped has a row in the items table; an item that succeeded leaves nothing behind. A list of 100,000 items with 20 problems keeps about `concurrency + 20` rows.
- **Retries per item.** A throw retries the item up to `attempts`, after `backoff`. A retry that waits does not hold up the items after it. An item out of attempts is recorded as `failed` with its error, and the list goes on: `step.each` does not fail because items failed, unless `maxFailures` says so. `ctx.skip(reason, data?)` ends an item as `skipped` (no retry).
- **Time-boxed ticks.** A tick works through items for at most `tickBudget` (30 seconds), waits for the items in flight, and hands the workflow back to the queue, which runs the next tick from the cursor. A long list never holds a queue slot for long, other work interleaves, and a process that shuts down stops starting items.
- **Crashes and deploys.** An item whose process died is found in flight by the next tick and runs again as its next attempt; one whose last attempt died is `failed`. Only the items in flight run again, never the ones that ended. Use the [database driver](./jobs-and-queues.md#the-database-driver): on the memory driver nothing survives a restart, and `step.each` warns once in production.
- **At least once.** As with `step.run`, an item can run twice when its process dies after the work and before the result is stored. `ctx.idempotencyKey` is `<workflow id>:<step key>:<item key>`, the same on every attempt; pass it to anything that must not happen twice (a payment, a generated file stored under that name, an email).
- **Progress.** While the step runs, the workflow's `progress` is the share of its items that have ended (`progress: false` turns that off), and its entry in `Workflow.find(id).steps` carries `status: "iterating"`, `progress` and `items: { total, done, succeeded, skipped, failed }`.

`item(index)` must return the same input for the same index for as long as the step runs: read from a table, a stored file or a snapshot of ids taken in an earlier `step.run`, not from a query whose order changes as the items are worked on. `count` is stored the first time; a later pass that computes another count goes on with the stored one.

| Option | Description |
| --- | --- |
| `count` | How many items, from 0. Required, unless `source` is given. |
| `item(index)` | Produces the input for `index`, sync or async. A throw counts as a failed attempt. Required, unless `source` is given. |
| `source` | A stored list (`step.source`, `ItemSource.write`), in place of `count` and `item`. See [item sources](#item-sources-stepsource-and-itemsource). |
| `key(input, index)` | The item key, a string of 1 to 191 characters or a number. Default: the index. gemi does not check that keys are unique. |
| `concurrency` | Items in flight at once, in the process running the tick. Default `1`. |
| `attempts` | Attempts per item, counting the first. Default `3`. |
| `backoff` | Milliseconds before each retry, as `step.run`'s. Default `0`. |
| `timeout` | How long one attempt may take; `ctx.signal` is aborted when it passes. |
| `tickBudget` | How long one tick works before handing over. Default `"30s"`. |
| `progress` | Whether the step sets the workflow's `progress`. Default `true`. |
| `throttle` | `{ key, limit, window }` or a list of them: at most `limit` items start per `window`, across every process sharing the queue's lock store. See [rate limits](#rate-limits-throttle-and-ctxrelease). |
| `transaction` | `true` runs each item in an ORM transaction that also records its end. See [transactional items](#transactional-items-transaction-and-chunk). |
| `chunk` | Hands `fn` up to this many items at once. See [transactional items](#transactional-items-transaction-and-chunk). |
| `maxFailures` | Fails the step once more than this many items failed, or `{ ratio, after? }`: once the share of failed items among those that ended is over `ratio` and at least `after` (default 20) have ended. Default: never. |

`fn` gets the input and an `ItemContext`: `index`, `key`, `attempt`, `idempotencyKey`, `signal` (aborted on `timeout` and on cancel), `skip(reason, data?)` and `release(delayMs)`. Its return value is not kept.

**`maxFailures`.** Past it, the items in flight are stopped, no more start, and the step fails: `step.each` throws a `StepFailedError` whose `summary` is where the items stood, problems included, on this pass and every later one. Catch it in `run` to report, or let the workflow fail.

```typescript
try {
  await step.each("rows", { source: rows, maxFailures: { ratio: 0.5, after: 20 } }, importRow);
} catch (error) {
  if (!(error instanceof StepFailedError) || !error.summary) throw error;
  await step.run("report", () => notifyImportFailed(importId, error.summary));
}
```

The summary lists the first 100 problems (`{ index, key, status, reason, data?, attempt }`, by index); `moreProblems` says whether there are more. `Workflow.items(id, key, { status?, after?, limit? })` pages through all of them:

```typescript
const failed = await Workflow.items(workflowId, "rows", { status: "failed", limit: 50 });
const next = await Workflow.items(workflowId, "rows", { status: "failed", after: failed.at(-1)?.index });
```

Cancelling the workflow aborts the items in flight through `ctx.signal` and starts no more; `onCancel` then runs as usual, and `Workflow.find` shows how far the list got. [Pausing](#pausing) it lets the items in flight finish and starts no more until it is resumed.

#### Rate limits: `throttle` and `ctx.release`

`throttle: { key, limit, window }` counts one hit per item started (a retry too) in the queue's lock store (`gemi_locks` with the database driver), the same fixed windows as a [job's `throttle`](./jobs-and-queues.md#per-key-throttles-and-concurrency--throttle-concurrency), under the same keys: a job and a `step.each` with one key share the budget. An item over the limit waits without using an attempt. A wait that fits in the tick happens in it; a longer one hands the workflow back until the window resets, so no process sleeps on it.

```typescript
await step.each("pictures", {
  source: products,
  concurrency: 4,
  throttle: { key: `images:${orgId}`, limit: 20, window: "1s" },
}, async (product, ctx) => {
  const response = await generatePicture(product, ctx.signal);
  if (response.status === 429) ctx.release(30_000); // try this item again in 30 s, and hold the rest
  await storePicture(product.id, response, ctx.idempotencyKey);
});
```

`ctx.release(delayMs)` puts the item back to start again after `delayMs` without using an attempt, for a provider that answered "slow down", and holds the whole step for as long: no item starts before then.

#### Transactional items: `transaction` and `chunk`

With `transaction: true`, `fn` runs inside an ORM transaction on the queue's connection (`Model.create`, `DB.query` and the rest join it), and the item's end is the last statement of that transaction. The item's writes and its being done commit together or not at all: a crash, a lost lease, a `timeout`, a cancel or a throw rolls both back, and the item runs again with nothing of the failed attempt left behind. Database writes are then exactly once; calls to other services in `fn` are still at least once, so keep passing `ctx.idempotencyKey`. `ctx.skip` and `ctx.release` roll back too.

It needs the [database driver](./jobs-and-queues.md#the-database-driver) on Postgres or MySQL, on a named connection (as `driver: "database"` builds it). On the memory driver and on SQLite `fn` runs without a transaction, the item is at least once, and gemi warns once. Keep the work in `fn` short: the transaction holds a connection while it runs.

`chunk: n` hands `fn` up to `n` items at once, as an array, with a `ChunkContext`, so their writes go in one statement or, with `transaction`, one transaction per chunk:

```typescript
await step.each("rows", { source: rows, chunk: 25, transaction: true, key: (row) => row.sku }, async (batch, ctx) => {
  for (const [position, row] of batch.entries()) {
    if (!row.name) {
      ctx.skip(position, "no name");
      continue;
    }
    await Product.create(toProduct(row)); // in the chunk's transaction
  }
});
```

- `ctx.items` has each item's `index`, `key` and `idempotencyKey`, in the order of the inputs. `ctx.skip(position, reason, data?)` ends one item of the chunk as `skipped` and does not throw: the rest of the chunk succeeds.
- A throw fails the attempt of every item in the chunk; each is retried, or fails, on its own attempts. A retried item may land in a different chunk.
- `concurrency` counts chunks in flight, and `ctx.attempt` is the highest attempt among the chunk's items.

### Item sources: `step.source` and `ItemSource`

`item(index)` needs somewhere stable to read from. When the list is not already a table (the rows of an uploaded file, a snapshot of ids), keep it in an **item source**: a table of the queue's database that holds a list item by item, written as it is produced and read a window at a time.

Inside a workflow, `step.source(key, fn)` writes the list `fn` returns (an array, or any iterable or async iterable, such as a parser over a stream) once, and `step.each` takes it as its `source` in place of `count` and `item`:

```typescript
async run(step: Step, importId: string, fileName: string) {
  const rows = await step.source("rows", async () => parseRows((await Storage.read(fileName)).body));

  return step.each("import", { source: rows, concurrency: 4, key: (row) => row.sku }, async (row, ctx) => {
    await createProduct(row, ctx.idempotencyKey);
  });
}
```

- Items are written as they come, 500 per insert, so a long list is never held in memory. Each item is JSON, at most 64 KB (`ITEM_SOURCE_ITEM_LIMIT`); store a file's name for anything larger.
- `step.source` is a step like `step.run` (same `attempts`, `backoff` and `timeout`): its result is the small `{ id, count }`, stored and replayed, and a write that fails part way is written again from the start. Its id is `<workflow id>:<key>`, and the source is deleted with the workflow when it is pruned.
- `step.each({ source })` reads at least 64 items (or four times `concurrency`) per query, and an item read again for a retry alone.

Outside a workflow, for example in the request that receives an upload, `ItemSource` does the same under an id of your choice:

```typescript
import { ItemSource } from "gemi/services";

const rows = await ItemSource.write(`upload:${upload.id}`, parseRows(file.stream())); // { id, count }
await ImportProductsWorkflow.start(upload.id, rows); // run: step.each("import", { source: rows }, …)

await ItemSource.read(rows.id, 0);           // one item, or undefined
await ItemSource.readRange(rows.id, 0, 20);  // a preview
await ItemSource.delete(rows.id);            // when done with it
await ItemSource.prune("7d");                // from a cron: sources of ItemSource.write older than a week
```

`ItemSource.write` replaces what was under the id. Sources it writes belong to no workflow: delete them, or prune them from a cron.

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

## Following a workflow: `Workflow.stream` and `useWorkflow`

Every change to a workflow (a step starting or ending, an item of a `step.each`, a sleep, a signal, the end) is published to its [change feed](./change-feed.md) channel, `gemi:workflow:<id>` (`Workflow.channel(id)`). Publishes are coalesced: at most one per workflow every 250 ms, each carrying the workflow as it is then, so the last change is always published. What is published is a `WorkflowUpdate`: the status `Workflow.find` returns without `args` and `result`, which can hold what a browser must not see.

On the server, `Workflow.subscribe(id, { signal? })` yields the workflow as it is now, then each newer update, and ends after the one that ended it:

```typescript
for await (const update of Workflow.subscribe(workflowId, { signal })) {
  console.log(update.status, update.progress);
}
```

In the browser, a route answers with `Workflow.stream(req, id)`, an SSE response. Authorise the read first, as for any route:

```typescript
// app/http/routes/api.ts
"/imports/:importId/progress": this.get(async (req: HttpRequest<{}, { importId: string }>) => {
  const record = await ProductImport.findFirst({ where: { id: req.params.importId, userId: (await Auth.user()).id } });
  if (!record) return new Response(null, { status: 404 });
  return Workflow.stream(req, record.workflowId);
}),
```

The view that renders the page passes the workflow and a cursor along, so the client starts from what the view showed:

```typescript
const workflow = await Workflow.find(record.workflowId);
return { workflow, workflowCursor: await Workflow.cursor(record.workflowId) };
```

```tsx
import { useWorkflow } from "gemi/client";

const { workflow } = useWorkflow(
  "/imports/:importId/progress",
  { params: { importId } },
  { initial: data.workflow, cursor: data.workflowCursor },
);
const rows = workflow?.steps.find((step) => step.key === "rows")?.items;
// <progress value={workflow?.progress ?? 0} />, `${rows?.done} of ${rows?.total}`
```

`useWorkflow` keeps the later of two updates (by `updatedAt`), reconnects and resumes from its cursor like [`useSubscription`](./change-feed.md#following-a-route-usesubscription), and disconnects once the workflow has ended. `onReset` is called when it was away longer than the feed keeps changes; the next update brings the whole status again.

The channel goes through the application's change feed, so it reaches every instance that shares it: use the feed's [database driver](./change-feed.md#the-database-driver) when the instance that runs the workflow is not the one serving the stream.

## Pausing

`Workflow.pause(id)` marks the workflow `paused`. No new step starts: a `step.run` in flight finishes and is recorded, a `step.each` lets its items in flight finish and starts no more, and the tick then lets go. A paused workflow holds no queue slot and runs nothing, even past a `step.sleep`; signals and batches that end meanwhile are kept. `Workflow.resume(id)` sets it `running` and queues a tick at once, which goes on where it stopped: a `step.each` from its cursor, a sleep that is over at once. A paused workflow can still be cancelled; `onCancel` runs as usual.

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
| `status` | `running` (also between the ticks of a `step.each`), `sleeping` (a sleep or a retry's delay), `waiting` (a signal or a batch), `paused`, `cancelling`, or one of the final `completed`, `failed`, `cancelled`. |
| `currentStep` | The key of the step it is on, or `null`. |
| `progress` | 0 to 1: what `step.progress` set, or the share of items a running `step.each` has done, and 1 once completed. |
| `result` | What `run` returned, once completed. |
| `error` | Why it failed, or why `onCancel` failed. |
| `steps` | Every step recorded so far, in the order first reached: `key`, `status`, `attempt`, `error`, `batchId`, `wakeAt`, `startedAt`, `finishedAt`, for a batch step its `progress`, and for a `step.each` its `progress` and `items` (`total`, `done`, `succeeded`, `skipped`, `failed`). |
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

`step.each` also needs a third table for its item rows, and item sources a fourth. A workflow that uses neither never touches them:

```prisma
model GemiWorkflowItem {
  workflowId String  @map("workflow_id")
  stepKey    String  @map("step_key")
  index      Int     @map("idx")
  key        String? @map("item_key")
  status     String
  attempt    Int     @default(0)
  error      String?
  output     String?
  wakeAt     BigInt? @map("wake_at")
  startedAt  BigInt? @map("started_at")
  finishedAt BigInt? @map("finished_at")
  createdAt  BigInt  @map("created_at")
  updatedAt  BigInt  @map("updated_at")

  @@id([workflowId, stepKey, index])
  @@map("gemi_workflow_items")
}

model GemiWorkflowSource {
  sourceId   String  @map("source_id")
  index      Int     @map("idx")
  workflowId String? @map("workflow_id")
  payload    String
  createdAt  BigInt  @map("created_at")

  @@id([sourceId, index])
  @@index([workflowId])
  @@map("gemi_workflow_sources")
}
```

On MySQL, add `@db.LongText` to `args`, `result` and `error` of `GemiWorkflow`, to `output` and `error` of `GemiWorkflowStep`, to `error` and `output` of `GemiWorkflowItem`, and to `payload` of `GemiWorkflowSource`. Without Prisma, `await driver.createTable()` creates all four tables (`IF NOT EXISTS`). Until they exist, everything else works and `start` rejects with an error that names what is missing.

A driver on another jobs table keeps workflows in `<table>_workflows`, `<table>_workflow_steps`, `<table>_workflow_items` and `<table>_workflow_sources`, or in the tables named by the `workflowTable`, `workflowStepTable`, `workflowItemTable` and `workflowSourceTable` options. Ended workflows are kept until `driver.workflowStore().prune(olderThanMs)` deletes them with their steps, items and `step.source` sources, for example from a cron job. The memory driver keeps ended workflows for a day.

A custom queue driver supports workflows by implementing `workflowStore()` (see `WorkflowStore`) and the batch methods; its store supports `step.each` by implementing `listItems` and the `items` parts of `update`, and item sources by implementing `writeSource`, `readSource`, `deleteSource` and `pruneSources`.

## Limits

- **No determinism check beyond keys.** gemi checks that keys are unique and that a key keeps its kind of step. It cannot check that code outside the steps is deterministic; that is up to the workflow.
- **One signal per key.** To receive several events, wait on keys that include a counter or an id.
- **No `step.waitFor` on gemi Events yet**, only `signal`.
- **Workflows cannot be restarted** once they have failed. Start a new one.
