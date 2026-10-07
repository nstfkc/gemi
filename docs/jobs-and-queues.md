# Jobs & Queues

Jobs move slow or non-essential work off the request path. Instead of making a user wait while you call an external API, generate an image, or send a batch of emails, you dispatch a **Job** — it runs in the background through gemi's queue, and the request returns immediately.

> **By default the queue lives in the server's memory, and a restart loses it.** Every job that is waiting, waiting out a retry, or halfway through `run` is gone when the process exits — a deploy, a scale-in, a crash — and no hook fires for any of them. [`driver: "database"`](#the-database-driver) keeps them in your database instead. See [Drivers](#drivers--where-queued-jobs-live).

You define jobs as classes extending `Job` (from `gemi/services`) in files under `app/jobs/`, and fire them with `Job.dispatch(...)`. The directory is read at boot, so there is no list to keep alongside it.

## Defining a job

A job is a class extending `Job` with a **static `name`** and a `run` method that does the work. The parameters of `run` are your job's payload.

```typescript
// app/jobs/ProcessVideoJob.ts
import { Job } from "gemi/services";

type Params = {
  videoId: string;
};

export class ProcessVideoJob extends Job {
  static name = "ProcessVideoJob";

  async run(params: Params) {
    // Slow, non-blocking work the user shouldn't wait on: transcode the
    // uploaded video, generate thumbnails, store the results, etc.
    await transcodeVideo(params.videoId);
  }
}
```

> **Note:** The static `name` is **required** — jobs are enqueued and dispatched to workers by this name, and dispatching a job whose `name` is still the default (`"unset"`) throws. Give every job a unique static `name`.
>
> Omitting it does not fall back harmlessly to the class name, and under discovery it fails in production only. `gemi build` minifies the server entry, and the app code reachable from it — a controller, and every job class it imports to dispatch — is bundled and minified with it. That renames the class binding, and a class's implicit `.name` *is* that binding, so `TestJob` becomes something like `D` in the bundle. Discovery reads `app/jobs/TestJob.ts` from source at runtime, where it is still `TestJob`, and the two halves stop agreeing. A declared `static name` is a string literal, which survives minification intact. Discovery warns at boot about any job that leaves it out.

### Lifecycle hooks

`Job` exposes hooks that run around `run`, each receiving the result/error plus the original `run` arguments:

```typescript
export class ProcessVideoJob extends Job {
  static name = "ProcessVideoJob";
  maxAttempts = 3; // retries before dead-lettering (default 3)
  backoff = [1_000, 10_000]; // ms before each retry; the last repeats (default 0)

  async run(params: Params) { /* ... */ }

  onSuccess(result: any, params: Params) { /* ran after run resolves */ }
  onFail(error: Error, params: Params) { /* ran on each failed attempt */ }
  onDeadletter(error: Error, params: Params) { /* ran after the last attempt fails */ }
}
```

Retry behavior: when `run` throws, `onFail` fires and the job is re-queued, `backoff` milliseconds later, until it has been attempted `maxAttempts` times; once the final attempt fails, `onDeadletter` fires and the job is dead-lettered — dropped by the memory driver, kept with its error by the database driver. A throw from `onSuccess` counts as a failed attempt; a throw from `onFail` or `onDeadletter` is logged and changes nothing.

An attempt whose process died before it finished still counts. With a driver that outlives the process, the job is claimed again once its lease runs out, and a job whose last attempt was lost that way reaches `onDeadletter` — with an error saying so — without running again.

### Configurable fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `static name` | `string` | `"unset"` | Unique job identifier. Required. |
| `maxAttempts` | `number` | `3` | Total attempts before dead-lettering. |
| `backoff` | `number \| number[]` | `0` | Milliseconds before a retry. An array gives one per retry, its last entry repeating. |
| `worker` | `boolean` | `false` | When `true`, `run` executes in a separate Worker thread (a fresh cloned app instance) instead of the main event loop — use for CPU-bound work you want off the main thread. |

## Dispatching

Call the static `dispatch` method with exactly the arguments your `run` method takes — the call is fully typed against `run`'s signature.

```typescript
import { ProcessVideoJob } from "@/app/jobs/ProcessVideoJob";

// Inside a controller — returns immediately; the job runs in the background.
const jobId = await ProcessVideoJob.dispatch({ videoId: video.id });
```

`dispatch` enqueues the job and resolves to its id once the driver has recorded it — it does not wait for the job to run, and the payload is serialized as JSON, so pass plain, serializable data (not class instances or functions). Payload that JSON cannot carry throws synchronously, before anything is queued. With the default memory driver the promise never rejects, so leaving it unawaited is fine; with a driver that can fail to record a job, await it, or the failure is an unhandled rejection. Inside a transaction, a job the database driver cannot record fails the transaction whether you await it or not — see [Dispatching inside a transaction](#dispatching-inside-a-transaction). See [Controllers](./controllers.md) for dispatching from request handlers.

A job runs in the application it was registered with, and outside the request that dispatched it: `app()` resolves as usual, but the dispatching request's user, cookies and open transaction are not there. Pass what the job needs as arguments.

### Dispatching inside a transaction

A dispatch inside `Model.transaction` or `DB.transaction` belongs to that transaction. The job is recorded when the transaction commits, and never if it rolls back, so it cannot run before the rows it was dispatched about exist, or when they never will:

```typescript
await Model.transaction(async () => {
  const order = await Order.create(input);
  await SendReceiptJob.dispatch({ orderId: order.id }); // recorded with the order
  await Billing.charge(order);                          // throws: no order, no job
});
```

How depends on the driver:

- **The database driver on Postgres or MySQL**, when the transaction is on the driver's own connection, writes the job's row on the transaction. The row commits with the order or not at all, and no replica can claim it before the commit.
- **Every other case** — the memory driver, the database driver on SQLite, the database driver on a connection other than the transaction's, and a driver of your own that does not say it can join (`joinsTransaction`) — holds the dispatch and enqueues it right after the commit. If the process dies between the commit and the enqueue, the job is lost.

Either way `dispatch()` resolves inside the transaction, to the id the job has or will have, so awaiting it there is fine. What differs is what a failure looks like:

- **Written on the transaction**, a job the database cannot record fails the transaction and rolls back its rows — whether or not you awaited `dispatch()`, and whether or not you caught its rejection. A queued listener's dispatch is never awaited, and on Postgres the failed statement has already aborted the transaction, so the commit waits for the job's row and rolls back if it failed rather than committing nothing and reporting success. Awaited and not caught, the transaction rejects with the database's error; otherwise with `TransactionDependencyError` from `gemi/orm`, whose `cause` is that error. Inside a savepoint only the savepoint rolls back, and catching its rejection keeps the rest of the transaction.
- **Held until the commit**, a job the driver cannot record fails after the transaction has committed. The rows stay, and the failure is only a line on stderr: `The queue driver could not record …, which was held until its transaction committed`.

A held dispatch inside a savepoint that rolls back is dropped with it, and one inside a savepoint that commits waits for the outer transaction, as [`afterCommit` events](./events.md#savepoints) do. The transaction's own promise resolves only after its held dispatches are recorded.

Only a transaction opened through gemi counts. One opened with Bun's `sql.begin` directly is invisible to the queue, and a dispatch inside it is recorded at once, on the pool.

## Registering jobs — `app/jobs/`

Jobs are discovered. Every class under `app/jobs` that extends `Job` is registered when the kernel boots, so writing the file is all it takes — there is no list to keep in step with it.

That is deliberate, and it is about the failure that happens when the two disagree. The queue looks a dispatched job up by name; a name it has never heard of is dropped with a line on stderr and nothing else. `Job.dispatch` has already returned by then — it returns as soon as the job is queued, not when it runs — so the dispatch simply does not happen, whatever was supposed to follow it does not either, and the only trace is in the server log.

### Two jobs, one class name

The queue's key is the **class name**, and that is also what a dispatch carries — so two `Job` subclasses called `SendEmail` cannot both be registered. The first is, the second is refused with a line on stderr, and `Job.dispatch` on either resolves to the first.

Worth spelling out because the failure it replaces was the worst one in this subsystem: the registry used to keep whichever came last, silently, so `SendEmail.dispatch(...)` written against `app/jobs/auth/SendEmail.ts` would run the body of `app/jobs/billing/SendEmail.ts`. Nothing was dropped and nothing errored — the wrong work happened and reported success. A hand-written list forced an import alias the moment two names clashed; a directory walk does not, so `auth/SendEmail.ts` beside `billing/SendEmail.ts` is an entirely ordinary thing to write. Rename one.

Both still appear in `registeredJobs`, which reports what the manager was handed rather than what the registry accepted, so a test walking it sees the clash.

### What the walk costs

A class does not exist until its module has run, so there is no way to read a directory of classes without importing it. **Every `.ts`/`.tsx` file under `app/jobs` is imported at boot** — in development and in production, on every start — and a file that *does something* when it is imported does that thing at boot. A module that opens a connection, seeds a cache, or registers a listener at the top level is doing it before the first request, from a directory nobody thought of as an entry point.

So `app/jobs` wants to hold job declarations rather than merely contain some. Keep a helper that runs work on import somewhere else, or list the jobs explicitly (below) and skip the walk entirely. A file that cannot be imported at all — one reaching a `?raw` or `.css` specifier through its imports, say — fails the boot naming itself, rather than being quietly left out of the registry.

The walk skips what certainly is not a declaration: `.d.ts` files, tests, type tests and benchmarks by their filename suffix, dot-directories, `node_modules`, and anything under a directory carrying its own `package.json`. Nothing else is guessed at.

A new file is picked up on the next server reload — under `gemi dev`, creating a file does not by itself trigger one, so save any other file (or restart) if a job you just wrote has not appeared.

### Configuring the queue — `app/config/queue.ts`

The `queue` slice is where `concurrency` lives, and where you can take over registration yourself. Declaring `jobs` turns discovery off and uses your list verbatim — reach for it when the jobs live somewhere the walk cannot reach, when you want a deliberate subset, or when the deploy ships only the build output and there is no `app/jobs` on disk to read.

```typescript
// app/config/queue.ts
import { defineQueueConfig } from "gemi/services";
import { ProcessVideoJob } from "@/app/jobs/ProcessVideoJob";

export default defineQueueConfig({
  concurrency: 20, // max jobs running at once (default 1)
  jobs: [ProcessVideoJob], // omit to discover them from app/jobs
});
```

`defineQueueConfig` is an identity helper — it exists only to type the object.

**A present `jobs` wins, and `jobs: []` is present.** An empty array means an application with no jobs and is honoured as such; it does not mean "go and find some". Leaving the key out — or leaving the slice out entirely — is what asks for discovery.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `jobs` | `(new () => Job)[]` | *discovered* | All dispatchable job classes. Omit to discover them from `jobsDir`. A job that reaches neither is dispatched into nothing. |
| `jobsDir` | `string` | `"app/jobs"` | Where to discover them. Relative to the project root, or absolute. |
| `concurrency` | `number` | `1` | Maximum number of jobs processed simultaneously. |
| `driver` | `"memory" \| "database" \| QueueDriver \| (app) => QueueDriver` | `"memory"` | Where queued jobs are kept. See [Drivers](#drivers--where-queued-jobs-live). |
| `visibilityTimeout` | `number` | `300000` | Milliseconds a claimed job is leased for before a driver shared between processes may hand it to another. Running jobs are heartbeated at a third of this. |
| `pollInterval` | `number` | `1000` | Milliseconds between claims for a driver that cannot announce new work. The memory driver is never polled. Also the delay before retrying a claim that failed — for any driver, doubling per consecutive failure up to a minute. |
| `unknownJobGrace` | `number` | `3600000` | Milliseconds a job under a name this replica has no class for is left for another replica before it is dead-lettered. Only for a driver other processes share; see [Deploys and unknown job names](#deploys-and-unknown-job-names). The memory driver dead-letters an unknown name at once. |

The slice is wired into the kernel by name:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import queue from "../config/queue";

export default class extends Kernel {
  config = { queue /* , ...other slices */ };
}
```

Behind the scenes the framework's `QueueServiceProvider` reads that slice in its `register()` and binds a `QueueManager` singleton into the container under the token `"queue"`, then fills in the discovered jobs in its `boot()`. You never construct or reference the provider yourself — providers register bindings, config configures them.

### Resolving the queue

`QueueManager` is a normal container binding, so you can resolve it directly when you need the manager rather than a job:

```typescript
import { app } from "gemi/foundation";
import { QueueManager } from "gemi/services";

app(QueueManager); // typed QueueManager, no cast
```

`registeredJobs` is the set it ended up with, discovered or declared. That is what a test asserts against now — an app that used to import the `jobs` array from its config module to check something about every job it dispatches asks the manager instead:

```typescript
import { app } from "gemi/foundation";
import { QueueManager } from "gemi/services";

for (const Registered of app(QueueManager).registeredJobs) {
  expect(new Registered().maxAttempts).toBeGreaterThan(0);
}
```

It may hold jobs you never wrote, named `listener:SendWelcomeEmail`. Those are [queued listeners](./events.md#queued-listeners) — a listener with `queued = true` is registered here as a job, so everything on this page applies to it, and the prefix is what tells you there is no job file to go and find.

`discoverJobs()` answers the same question without an application around it — it walks `app/jobs` (or a directory you name) and returns the classes it finds. Every file it walks is imported, as above:

```typescript
import { discoverJobs } from "gemi/services";

const jobs = await discoverJobs(); // every Job subclass under app/jobs
```

### Drivers — where queued jobs live

The `QueueManager` runs jobs; a **driver** keeps them. The default, `"memory"` (`MemoryQueueDriver`), keeps them in a `Map` in the server process. That is right for development and tests and wrong for anything you cannot afford to lose: **every waiting, retrying and running job disappears when the process exits**, silently. It also never leaves the process, so a job runs on the instance that dispatched it or not at all.

A driver is any object implementing `QueueDriver` from `gemi/services`. It is claim-based, so it can be shared by several processes:

| Method | What it promises |
| --- | --- |
| `enqueue({ name, args, delayMs?, id? })` | Records a job, claimable after `delayMs`, and resolves to its id. When `id` is given, the job is recorded under it: the queue passes one for a dispatch it held until a transaction committed, because that dispatch has already resolved to it. |
| `joinsTransaction?()` | Whether an `enqueue` made now would be written inside the caller's open ORM transaction. Answer `true` only if no claimer, this process's included, can see the job before the commit. Without it, the queue holds a dispatch made inside a transaction until the commit. |
| `claim(limit, { visibilityTimeoutMs, registered? })` | Leases up to `limit` claimable jobs, oldest first — by the moment each became claimable, not the moment it was enqueued — with `attempt` incremented. A job whose lease ran out is claimable again. Concurrent claims never share a job. `registered` is `{ names, graceMs }`: a driver that can should skip a job under a name not in `names` until it has been claimable for `graceMs`. Ignoring it is allowed. |
| `complete(job)` | Ends the claim; the job is never claimed again. |
| `fail(job, { error, retryInMs })` | Ends the claim. A number makes the job claimable after that long; `null` dead-letters it for good. |
| `release(job, { retryInMs })` | Ends the claim without counting it: the job is claimable again after `retryInMs`, with `attempt` back where it was before the claim. |
| `heartbeat?(jobs, { visibilityTimeoutMs })` | Extends the leases of jobs still running. |
| `subscribe?(wake)` | Calls `wake` when work may be claimable. Without it the queue polls every `pollInterval`. |
| `retryDead?(id)` | Makes a dead-lettered job claimable again as attempt 1 and resolves `true`, or resolves `false` if `id` is not dead. Without it, `QueueManager.retryDead` is refused. |

`complete`, `fail`, `release` and `heartbeat` receive the claimed job rather than its id, so a driver can ignore a report from a claim whose lease already ran out and was handed to someone else. Durations cross the interface as relative milliseconds, so a driver shared between machines can measure them on one clock.

Hand the driver to the slice as a function, so each application gets its own and nothing is opened by a process that only imports the config. The function is called with the application:

```typescript
// app/config/queue.ts
import { defineQueueConfig } from "gemi/services";
import { MyQueueDriver } from "@/app/queue/MyQueueDriver";

export default defineQueueConfig({
  driver: (app) => new MyQueueDriver(),
});
```

### The database driver

`driver: "database"` keeps jobs in a `gemi_jobs` table of your database, so they outlive the process. A job dispatched before a deploy, a scale-in or a crash is still there afterwards, and whichever replica is up claims it. It is written for SQLite, Postgres, and MySQL 8 or MariaDB 10.6+, in raw SQL rather than through the ORM, which does not support MySQL.

> **Tested on SQLite, Postgres 16 and MySQL 8.4.** CI runs the driver's whole suite — the contract, two workers over one database, lease recovery, dead letters — against each of the three on every push. MariaDB shares MySQL's path but is not run in CI, so try that one on a staging database first.

```typescript
// app/config/queue.ts
import { defineQueueConfig } from "gemi/services";

export default defineQueueConfig({
  driver: "database", // the default connection's gemi_jobs table
  concurrency: 20,
});
```

The table is yours to create, like every other table. With Prisma, add this model to `schema.prisma` and run `prisma migrate dev`. Prisma then owns the table and will not drop it as unknown:

```prisma
model GemiJob {
  id             String  @id
  name           String
  payload        String
  status         String
  attempts       Int     @default(0)
  availableAt    BigInt  @map("available_at")
  claimedAt      BigInt? @map("claimed_at")
  leaseExpiresAt BigInt? @map("lease_expires_at")
  lastError      String? @map("last_error")
  createdAt      BigInt  @map("created_at")
  updatedAt      BigInt  @map("updated_at")
  batchId        String? @map("batch_id") // for batches
  progress       Float?                   // for batches

  @@index([status, availableAt])
  @@index([status, leaseExpiresAt])
  @@index([batchId])
  @@map("gemi_jobs")
}
```

On MySQL, add `@db.LongText` to `payload` and `lastError`. Prisma's default there is `VARCHAR(191)`, which is too short for a job's arguments or a stack trace. Without Prisma, `await driver.createTable()` creates the same table and indexes if they do not exist. [Batches](#batches) also need the `GemiJobBatch` model.

For another connection or table name, build the driver yourself:

```typescript
import { DatabaseManager } from "gemi/database";
import { DatabaseQueueDriver, defineQueueConfig } from "gemi/services";

export default defineQueueConfig({
  driver: (app) =>
    new DatabaseQueueDriver(app.make(DatabaseManager).connection("jobs"), { table: "jobs" }),
});
```

**What it guarantees: at least once, not exactly once. Jobs must be idempotent.** A job runs again if its process dies after the work is done but before the row is removed. It can also run twice at the same time: if a process freezes, or cannot reach the database to renew its lease, for longer than `visibilityTimeout`, the lease runs out while the job is still running and another replica claims it.

How it works:

- **Claiming.** Each job is a row. Postgres and MySQL claim rows with `SELECT … FOR UPDATE SKIP LOCKED`, so replicas claiming at the same moment take different rows. On MySQL the claim runs at READ COMMITTED on a connection of its own, because MySQL's default REPEATABLE READ locks the gaps a range scan passes over as well as the rows it returns, and claimers then block or deadlock on each other instead of skipping past. The connection's isolation level is put back before it returns to the pool. SQLite runs one write at a time, so a single `UPDATE … RETURNING` claims atomically.
- **SQLite and a second process.** Bun opens SQLite with a busy timeout of 0, so a write that finds another process holding the file's lock fails at once with `SQLITE_BUSY`. The driver raises that to one second the first time it touches a SQLite connection, so `gemi dev` and a script or seed dispatching into the same file wait for each other instead. The setting belongs to the connection, so with `driver: "database"` it applies to the app's default connection too. A connection you already gave a busy timeout keeps it, and `new DatabaseQueueDriver(connection, { busyTimeout })` picks another value (`0` leaves the connection alone). Bun waits for the lock on the JavaScript thread, so the process serves nothing else while it waits. That is why the default is short. For more than one server, use Postgres or MySQL.
- **Leases.** A claim leases the job for `visibilityTimeout` (default five minutes). The queue renews the lease every third of that while the job runs. A job whose process died without finishing becomes claimable again when its lease runs out, and that is the whole of crash recovery. A lower `visibilityTimeout` retries such a job sooner, at the cost of more lease renewals.
- **Retries.** The attempt count and the last error are stored in the row, so `maxAttempts` and `backoff` hold across restarts. An attempt whose process died counts too.
- **Dead letters.** A job that used up its attempts stays in the table with `status = 'dead'` and its `last_error`. `app(QueueManager).retryDead(id)` runs it again from attempt 1, with all its `maxAttempts`, and resolves `false` if `id` is not a dead job — one that is waiting, running or gone is left alone. There is no `gemi` command for it yet; a [console command](./commands.md) of your own is a few lines around that call. From a console command the job waits for a server or a worker to claim it, up to `pollInterval`. `driver.prune(olderThanMs)` deletes dead rows older than that, for example from a cron job. Nothing else removes them.
- **Completed jobs** are deleted.
- **Time.** All times are milliseconds since the epoch, read from the database's clock, so replicas with skewed clocks agree on when a lease ran out. In Postgres, `to_timestamp(available_at / 1000.0)` gives a readable date.
- **Recovery on boot.** A production server with a durable driver starts claiming as soon as it boots, not at its first dispatch. That way a replica that serves no dispatches of its own still picks up what an earlier one left behind. Under `gemi dev`, the queue starts at the first dispatch, as before. A [worker](#worker-processes--gemi-queuework) claims from its boot in both.
- **`gemi dev` and a shared table.** `gemi dev` runs `bun --hot`, which boots a new application in the same process on every save. If the queue was claiming from the table before the save, the new application stops the old loop and starts its own, so jobs claimed after the save run the new code. A job that was already running finishes on the code it started with. If nothing had been dispatched yet, nothing starts. A memory queue is not handed over: only the application that owns it can dispatch into it, so it keeps running until it has finished what it holds.
- **Dispatching from outside a server.** A console command, a seed or a script that dispatches records the job and leaves it in the table for a server or a worker to claim. It does not start claiming itself, because it would take other replicas' jobs too and exit in the middle of running them.
- **Unknown job names.** A replica only claims jobs whose names it has a class for, until they have waited out `unknownJobGrace`. See [Deploys and unknown job names](#deploys-and-unknown-job-names).
- **Polling.** Another process's dispatch cannot wake this one, so the queue asks the database for work every `pollInterval` (default one second). A dispatch from this process wakes its own queue immediately.
- **Transactions.** On Postgres and MySQL, a dispatch inside a transaction on the driver's own connection writes its row on that transaction. On SQLite the queue holds it until the commit instead: Bun gives a SQLite client one connection, so the queue's own claim would run inside the open transaction and see the job before the commit. A driver built from a bare `{ sql, dialect }`, with no connection name, cannot tell which transaction is its own, and never joins one. See [Dispatching inside a transaction](#dispatching-inside-a-transaction).

### Deploys and unknown job names

During a blue/green or weighted rollout, both releases serve at once and claim from one `gemi_jobs` table. A job class that only the new release has — or one the new release deleted or renamed — then has a name that half the replicas do not know.

A replica never runs a job it has no class for, and with a driver other processes share it no longer dead-letters one at first sight either:

- **The database driver does not claim it.** Its claim is `WHERE name IN (…)` the replica's registered jobs, so the job waits for a replica that has the class, and the replica that does not never sees it.
- **A driver that cannot filter by name** hands it out anyway. The queue gives it back without spending an attempt — `release`, not `fail` — and logs one line per name: `Left a queued "…" for another replica`. It is claimable again after one to two `pollInterval`s, so other replicas get their turn at it.
- **After `unknownJobGrace`** (one hour by default) the name is taken to be gone rather than deployed elsewhere, and the job is dead-lettered with `No job is registered under the name "…"` as its `last_error`. The database driver measures the hour from when the job became claimable. A driver that cannot filter measures it from the dispatch, so a job delayed by longer than the window is dead-lettered by the first replica that does not know it.

Set `unknownJobGrace` longer than your slowest rollout, and longer than you would take to roll one back. A rollback within the window finds the other release's jobs still waiting. `Infinity` never dead-letters an unknown name, and leaves such jobs in the table until you remove them.

The memory driver is unchanged: nothing else can run its jobs, so an unknown name is dead-lettered at once, with a line on stderr.

The same rules apply to a single replica. A job class that discovery missed (a file outside `jobsDir`, say) used to be dead-lettered at once with a `No job is registered` line on stderr. With the database driver it now shows up as rows left `pending` under that name, with no output, until `unknownJobGrace` has passed. If dispatches seem to vanish, look for those rows.

### Stopping the queue

`app(QueueManager).drain(timeoutMs)` stops claiming, waits up to `timeoutMs` for the jobs already running, and resolves to `{ unfinished }` — the ones still running at the deadline. Nothing is cancelled. `stop()` is `drain(0)`. After either, a dispatch is recorded by the driver but not run until `start()` is called; with the memory driver, whatever is still waiting when the process exits is lost.

When a production server is told to stop (see [Graceful shutdown](./configuration.md#graceful-shutdown)), a queue with the database driver, or any other that outlives the process, stops claiming as soon as the signal arrives and leaves the waiting jobs to other replicas. The memory queue keeps claiming while in-flight requests drain, because no other process can run its jobs, so a job a draining request dispatches still runs. Either way, jobs already running continue, and the queue provider's `shutdown()` then stops claiming and waits for them, within the shared provider deadline (`GEMI_SHUTDOWN_PROVIDER_TIMEOUT`, 5 seconds by default). If a job is still running at the deadline, it is abandoned when the process exits, and the shutdown exits with code 1. With the memory driver that job is lost. With the database driver its row stays claimed until the lease runs out, and then another replica retries it. That retry counts as a new attempt, and it starts only after `visibilityTimeout`. If your jobs regularly run longer than the provider deadline, raise `GEMI_SHUTDOWN_PROVIDER_TIMEOUT` to fit the platform's grace period.

### Worker processes — `gemi queue:work`

By default every server process runs jobs as well as requests, so job capacity grows only with web replicas, and jobs share an event loop and memory with the requests. `gemi queue:work` boots the application and claims from the queue without serving HTTP, so the two can be scaled on their own signals: web replicas on request traffic, workers on queue depth.

```bash
gemi queue:work                        # beside gemi dev, from source
NODE_ENV=production gemi queue:work    # in a deployment
```

A deployment that splits web and worker runs the same build with the same config, and differs in two settings:

| Process | Command | Environment |
| --- | --- | --- |
| Web | `gemi start` | `GEMI_QUEUE_CLAIM=off` |
| Worker | `gemi queue:work` | `NODE_ENV=production` |

- **`GEMI_QUEUE_CLAIM=off` on the web process** stops it claiming: a dispatch from a request is recorded and left for a worker, and nothing is claimed at boot. The value is `off`, in any case. Unset or `on` claims as before, and any other value claims and warns at boot, because `false` or `0` reads as off and is not. A worker ignores the variable, so it is safe to set once for every container. Without it, web processes keep running jobs too, alongside the workers, which is also a valid setup.
- **The driver has to be one every process can reach**, such as `"database"`. With the memory driver a worker is pointless: a dispatch never leaves the process that made it, so a worker never sees a job. `gemi queue:work` refuses to start on the memory driver and exits `1`. A server ignores `GEMI_QUEUE_CLAIM=off` on the memory driver, with a warning at boot, because nothing else could run its jobs.
- **Each worker claims up to `concurrency` jobs at once**, so total job capacity is workers × `concurrency`. Pick `visibilityTimeout` and `concurrency` for the worker; the web process no longer uses them when it does not claim.
- **The cron scheduler does not start in a worker**, so adding workers does not add a copy of every cron job. `gemi queue:work` sets `GEMI_NO_SCHEDULE=1` unless the environment already sets it; set `GEMI_NO_SCHEDULE=0` to run the schedule in a worker instead.
- **`NODE_ENV` is inherited**, as for `gemi run`, not forced to production as for `gemi start`. Set `NODE_ENV=production` in the worker's deployment. A `worker = true` job loads `dist/server/bootstrap.mjs` in production, so the worker needs the same `gemi build` output as the server.

`SIGTERM` or `SIGINT` drains a worker the way it drains a server (see [Graceful shutdown](./configuration.md#graceful-shutdown)). The worker stops claiming at once and leaves waiting jobs to other workers. It waits up to `GEMI_SHUTDOWN_TIMEOUT` (20 seconds) for the jobs it is running, where a server waits for its requests, and then runs every provider's `shutdown()` within `GEMI_SHUTDOWN_PROVIDER_TIMEOUT` (5 seconds). In that step the queue waits for any job still running and names it. The exit code is `0` if no job was left running and every provider finished in time, and `1` otherwise. `GEMI_SHUTDOWN_DELAY` is not used, because no load balancer routes to a worker. A job cut off by the exit is retried once its lease runs out, as it is for a server.

See [Project Structure](./project-structure.md) for the full kernel layout.

> **Coming from Laravel:** the vocabulary is the same — a `ServiceProvider` registers bindings into the `Container`, config lives in `app/config`, and facades are static proxies to container-resolved services. Two things are deliberately different: job retry/failure behavior lives on the job class (`maxAttempts`, `onFail`, `onDeadletter`) rather than in a queue driver's config, and per-subsystem hooks across the framework (`filterRecipients`, `onLogCreated`, `detectLocale`, ...) are **config callbacks** in `app/config/*.ts` rather than macros you register from a provider's `boot()`. Use `boot()` only for wiring you cannot express as data — see `app/providers/AppServiceProvider.ts`.

> **Note:** With the default memory driver the queue is **in-memory**: enqueued jobs do not survive a restart, and a job runs in the server process that dispatched it (or, for `worker` jobs, a Worker thread it spawns). Use it for best-effort background work (translations, image processing, notifications). For work that must survive restarts, or to run jobs in [worker processes](#worker-processes--gemi-queuework) of their own, use the [database driver](#the-database-driver), and make the jobs idempotent.

## Unique jobs and locks

### Unique jobs — `uniqueId`

A job that returns a key from `uniqueId` is queued at most once per key. While a job with that key is waiting or running, another dispatch is not queued and resolves to the existing job's id:

```typescript
import { Job } from "gemi/services";

export class RebuildReport extends Job {
  static name = "RebuildReport";
  uniqueFor = 10 * 60_000; // the key frees itself after this at the latest (default one hour)

  uniqueId(reportId: string) {
    return `report:${reportId}`; // return undefined to make one dispatch not unique
  }

  async run(reportId: string) {
    // ...
  }
}

const a = await RebuildReport.dispatch("42");
const b = await RebuildReport.dispatch("42"); // b === a while that job waits or runs
```

The key is freed when the job completes or is dead-lettered, not between retries. With the database driver the key is a row in `gemi_locks`, so it holds across every process sharing the database. Inside a transaction, a unique dispatch waits for the commit (also on a driver that could write it on the transaction), and is dropped at the commit if a job with that key was queued by then.

### Per-key throttles and concurrency — `throttle`, `concurrency`

A job can limit itself per key, computed from its arguments. The limits hold across every process sharing the queue's storage (the `gemi_locks` table with the database driver; see [Locks](#locks--the-lock-facade)):

```typescript
import { Job } from "gemi/services";

export class SendPush extends Job {
  static name = "SendPush";
  maxAttempts = 5;

  throttle(userId: string) {
    return [
      { key: "push:global", limit: 20, window: 60_000 },
      { key: `push:user:${userId}`, limit: 1, window: 86_400_000 },
    ];
  }

  concurrency(userId: string) {
    return { key: `push:user:${userId}`, limit: 1 }; // across all workers
  }

  async run(userId: string, payload: Payload) {
    const response = await provider.send(userId, payload);
    if (response.status === 429) return this.release(30_000); // try again later, no attempt spent
    if (response.uncertain) return this.fail(new Error("acceptance unknown"), { retry: false });
  }
}
```

- **`throttle`** returns one or more `{ key, limit, window }` budgets. A job that would go over one is put back until that window ends. It does not spend an attempt, so it never reaches the dead-letter queue by waiting. Windows are fixed (they start at the first job admitted after the last one ended), and a job is counted when it is admitted to run, whether it then succeeds or not.
- **`concurrency`** returns `{ key, limit }`: at most `limit` jobs with that key run at once. A job with no free slot waits, again without spending an attempt. Each slot is a lock leased for `visibilityTimeout` and renewed while the job runs, so a slot held by a process that died frees itself.
- **`this.release(delayMs)`** inside `run` puts the job back to wait `delayMs` once `run` returns, without counting the attempt and without calling `onSuccess` or `onFail`.
- **`this.fail(error, { retry: false })`** inside `run` dead-letters the job once `run` returns, whatever `maxAttempts` says. Use it where repeating the work is worse than losing it. Without `retry: false` it fails the attempt like a throw.

`release` and `fail` are not available to `worker = true` jobs, whose `run` happens in another thread.

### Locks — the `Lock` facade

Underneath is a lock with a lease and a fencing token. The queue keeps it where it keeps jobs: the `gemi_locks` table with the database driver, this process's memory with the memory driver. No Redis is needed.

```typescript
import { Lock } from "gemi/facades";

const result = await Lock.run("usage-snapshot", { ttl: 60_000 }, async (lock) => {
  const usage = await heavyQuery({ signal: lock.lost });
  // Commits only if this process still holds the lock; refused with LockLostError otherwise.
  await lock.fence(() => UsageSnapshot.upsert({ where: { id: 1 }, create: usage, update: usage }));
  return usage;
});
if (!result.acquired) {
  // another process is computing it
}
```

- **`Lock.run(name, { ttl, wait }, fn)`** takes the lock, renews the lease every third of `ttl` while `fn` runs, and releases it after. It resolves `{ acquired: false }` if the lock is held (after waiting up to `wait` milliseconds, default no wait).
- **`lock.token`** grows with each new holder of the name. Store it beside a write if another system must refuse older holders.
- **`lock.lost`** is an `AbortSignal`. It aborts when a renewal finds another holder, or when the lease runs out by this process's clock without a successful renewal (for example while the database is unreachable). If the hold was lost, `Lock.run` rejects with `LockLostError` after `fn` settles instead of resolving.
- **`lock.fence(fn)`** runs `fn` in a transaction that first locks the lock's row and checks the hold is current. ORM writes inside it commit only while this process holds the lock, and a new holder waits for the commit. A stale holder's fenced write is refused.
- **`Lock.acquire(name, options)`** returns the `HeldLock` (or `null`) for manual use. Release it with `lock.release()`; it is not renewed unless you pass `renew: true`.

With the database driver, add the table. With Prisma:

```prisma
model GemiLock {
  name      String @id
  owner     String
  token     BigInt @default(0)
  expiresAt BigInt @map("expires_at")
  updatedAt BigInt @map("updated_at")

  @@map("gemi_locks")
}
```

Without Prisma, `await app(QueueManager).locks.store.createTable()` (a `DatabaseLockStore`) creates it. Nothing reads or writes the table until a unique job, a `withoutOverlapping` or `onOneServer` cron job, or the `Lock` facade is used. Rows are kept after release so tokens keep growing; `store.prune(olderThanMs)` deletes idle ones.

The queue slice's `locks` picks another store: `"auto"` (the default: the driver's own), `"memory"`, `"database"` (the default connection), a `LockStore`, or `(app) => LockStore`.

## Batches

`Job.dispatchBatch` queues one job per argument tuple as a **batch**, and runs follow-up jobs once the batch is done. Use it for a fan-out whose end matters, for example building every page of an import and then reporting which ones failed.

```typescript
import { Job } from "gemi/services";
import { BuildPageJob } from "@/app/jobs/BuildPageJob";
import { ImportFinishedJob } from "@/app/jobs/ImportFinishedJob";
import { ImportFailedJob } from "@/app/jobs/ImportFailedJob";
import { ImportCleanupJob } from "@/app/jobs/ImportCleanupJob";

const batch = await BuildPageJob.dispatchBatch(
  pages.map((page) => [page.id, importId] as const), // one `run` tuple per job
  {
    name: `import:${importId}`,
    allowFailures: true,                       // default false: the first failure cancels the rest
    then: ImportFinishedJob.with(importId),    // every job ended, and none failed (or allowFailures)
    catch: ImportFailedJob.with(importId),     // the first failed job, or a cancel
    finally: ImportCleanupJob.with(importId),  // every job ended, whatever happened
  },
);
// batch: { id, total }

const status = await Job.findBatch(batch.id); // BuildPageJob.findBatch works too
await Job.cancelBatch(batch.id);
```

Each tuple is typed against `run`, like `dispatch`'s arguments. The jobs, the batch and its callbacks are recorded in one atomic write: all of them or none. Inside a transaction a batch behaves like a [single dispatch](#dispatching-inside-a-transaction): it is recorded when the transaction commits and dropped if it rolls back.

### Callbacks are jobs

`then`, `catch` and `finally` are jobs, not functions. `SomeJob.with(...args)` names a job and its arguments without dispatching it. When a callback becomes due, it is enqueued with the batch's status appended as its last argument, so it is retried and dead-lettered like any other job and survives a deploy:

```typescript
import { type BatchStatus, Job } from "gemi/services";

export class ImportFinishedJob extends Job {
  static name = "ImportFinishedJob";

  async run(importId: string, batch: BatchStatus) {
    await markImportDone(importId, { failedJobs: batch.failedJobIds });
  }
}
```

`with` leaves a trailing `BatchStatus` parameter out of the arguments it asks for, because the batch adds it.

Each callback is enqueued **exactly once**, by whichever process ends the job that makes it due. The database driver ends the job, updates the batch's counters and enqueues the callbacks in one transaction, so a crash in between leaves none of it done, and a slow worker whose lease was taken over cannot count its job twice. `then` and `finally` are enqueued together, `then` first, so they may run at the same time on different workers. Don't rely on `finally` running after `then` has finished.

| Callback | Enqueued when |
| --- | --- |
| `then` | Every job has ended, the batch was not cancelled, and no job failed (or `allowFailures` is set). |
| `catch` | The first job is dead-lettered, or the batch is cancelled, whichever comes first. Once. |
| `finally` | Every job has ended, whatever happened. |

A job's own `onSuccess`, `onFail` and `onDeadletter` still run as usual. A batch callback is an extra on top of them.

### Failures and `allowFailures`

A job of a batch fails the way any job does: it is retried up to `maxAttempts` and then dead-lettered. Only the dead-letter counts against the batch. Without `allowFailures`, the first dead-lettered job **cancels the batch**: its waiting jobs never run, `catch` and then `finally` are enqueued, and `then` is not. With `allowFailures: true` the rest keep running, `catch` still runs at the first failure, and `then` runs at the end with the failed jobs listed in `failedJobIds`.

### Progress — `this.progress()`

Inside `run`, `this.progress(fraction)` reports how far the job is, from 0 to 1. The batch's `progress` is the ended jobs plus what the running jobs reported, divided by `total`. A retry starts its job from 0 again. Each call is one write, so report at steps rather than for every item of a loop. Outside a batch, `this.progress()` does nothing.

```typescript
async run(pageId: string, importId: string) {
  const page = await fetchPage(pageId);
  await this.progress(0.5);
  if (await this.batch?.cancelled()) return; // stop early once the batch is cancelled
  await renderPage(page);
}
```

### Status — `Job.findBatch(id)`

`Job.findBatch(id)` resolves to the batch's status, or `null` for an id the queue has no batch under:

| Field | Description |
| --- | --- |
| `id`, `name` | The batch's id and the `name` it was dispatched with (or `null`). |
| `total` | How many jobs it was dispatched with. |
| `pending` | Jobs that have not ended: waiting, running, or waiting out a retry. |
| `succeeded`, `failed`, `cancelled` | How the ended ones ended. `cancelled` jobs never ran to the end because the batch was cancelled. |
| `failedJobIds` | The ids of the dead-lettered jobs, in the order they failed. |
| `progress` | 0 to 1; see above. |
| `cancelledAt`, `finishedAt`, `createdAt` | Epoch milliseconds, or `null`. `finishedAt` is set when the last job ends. |

### Cancelling — `Job.cancelBatch(id)`

`Job.cancelBatch(id)` resolves to `true` if it cancelled a running batch, and to `false` for one that is unknown, finished or already cancelled. The batch's waiting jobs are dead-lettered unrun (with `last_error` saying why) and counted as `cancelled`. A job that is already running is not interrupted: it finishes unless it checks `this.batch?.cancelled()` and returns early. A cancelled job's `onDeadletter` does not run. `catch` is enqueued at once, unless a failure already enqueued it, and `finally` once the running jobs have ended.

### Limits

- **Worker jobs** (`worker = true`) and **unique jobs** (`uniqueId`) cannot be dispatched in a batch, and `dispatchBatch` throws for them. A worker thread has no way to report progress, and a deduplicated job would leave the batch waiting for a job that is not part of it.
- **One job class per batch.** For several classes, dispatch several batches.
- **No adding jobs** to a batch that has been dispatched.
- **A dead-lettered job of a batch cannot be retried** with `retryDead`, which resolves `false` for it, because the batch has already counted it.
- **Drivers.** The memory driver keeps batches in memory, and finished ones for a day. The database driver keeps them in a `gemi_job_batches` table; see below. A driver of your own supports batches by implementing `enqueueBatch`, `findBatch`, `cancelBatch` and `reportProgress` (see `QueueDriver`), and `dispatchBatch` throws on one that does not.

### The batches table

With `driver: "database"`, batches need the `GemiJobBatch` model and the `batchId` and `progress` fields of the [`GemiJob` model](#the-database-driver). Add them and run `prisma migrate dev`:

```prisma
model GemiJobBatch {
  id           String  @id
  name         String?
  total        Int
  pending      Int
  succeeded    Int     @default(0)
  failed       Int     @default(0)
  cancelled    Int     @default(0)
  failedJobIds String  @map("failed_job_ids")
  options      String
  cancelledAt  BigInt? @map("cancelled_at")
  finishedAt   BigInt? @map("finished_at")
  createdAt    BigInt  @map("created_at")
  updatedAt    BigInt  @map("updated_at")

  @@map("gemi_job_batches")
}
```

On MySQL, add `@db.LongText` to `failedJobIds` and `options`. Without Prisma, `await driver.createTable()` creates the table and adds the two columns to an existing `gemi_jobs`. Until then, everything except batches works as before, and `dispatchBatch` rejects with an error that names what is missing. A driver on another jobs table keeps its batches in `<table>_batches`, or in the table named by the `batchTable` option. Finished batches are kept until `driver.pruneBatches(olderThanMs)` deletes them, for example from a cron job.

## When to use a job

Reach for a job when work is:

- **Slow** — external API calls, AI generation, image/video processing.
- **Non-blocking** — the user doesn't need the result in the HTTP response.
- **Batchable or retryable** — sending many emails, syncing records, where automatic retries help. For a fan-out whose end matters, see [Batches](#batches).

For work in several stages that must survive deploys, sleep or wait for a person (crawl, wait for a choice, charge once, build, report), use a [Workflow](./workflows.md).

For work that must happen on a **schedule** (nightly reports, hourly cleanups) rather than in response to a request, use a cron job instead — see [Cron](./cron.md).

## Related

- [Commands](./commands.md) — one-off work a person starts by hand, which often dispatches jobs.
- [Cron](./cron.md) — scheduled, recurring background work.
- [Controllers](./controllers.md) — dispatching jobs from request handlers.
- [Project Structure](./project-structure.md) — the kernel, `app/config/*.ts`, and service providers.
- [Configuration](./configuration.md) — environment setup.
