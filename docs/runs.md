# Runs

A run is a tracked piece of background work: a page build, a site import, a render. It is a small record with a status, a progress report, a result or an error, and an optional deadline. Whoever does the work (a queue job, a webhook handler) moves it along, and whoever needs the outcome (a route, an MCP tool, another job, the browser) reads it, waits for it or streams it.

Every change to a run is published to its [change feed](./change-feed.md) channel, so a waiter is woken when the run changes, on any instance sharing the feed, instead of polling a row.

```typescript
import { Runs } from "gemi/facades";

// Where the work is asked for: record the run, then queue the work.
const run = await Runs.create({
  kind: "page-build",
  subject: `site:${site.id}`,
  owner: `user:${user.id}`,
  deadline: "10m",
});
await PageBuildJob.dispatch({ runId: run.id, pageId });
```

```typescript
// app/jobs/PageBuildJob.ts: the work
import { Job, RunFailure } from "gemi/services";
import { Runs } from "gemi/facades";

export class PageBuildJob extends Job {
  static name = "PageBuildJob";

  async run({ runId, pageId }: { runId: string; pageId: string }) {
    await Runs.execute(runId, async (run) => {
      await run.progress({ fraction: 0.2, message: "Writing copy" });
      const page = await buildPage(pageId, { signal: run.signal });
      if (!page) throw new RunFailure("The page is gone.", { code: "not_found" });
      return { pageId: page.id };
    });
  }
}
```

```typescript
// Wherever the outcome is needed: an MCP tool, another job, a route.
const done = await Runs.wait(run.id, { timeout: "2m" });
if (done.status === "completed") return done.result;
```

## The record

```typescript
type RunRecord<R = unknown, P = unknown> = {
  id: string; // "run_…", unless you gave one
  kind: string; // "page-build"
  subject: string | null; // "site:42": what it works on, to find it again
  owner: string | null; // "user:7": who started it
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
  meta: unknown; // what the starter said about it, fixed once created
  progress: { fraction?: number; message?: string; data?: P } | null;
  result: R | null; // once completed
  error: { message: string; code?: string; data?: unknown } | null;
  version: number; // 1, then one more per change
  createdAt: number; // epoch milliseconds, on the store's clock
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  deadlineAt: number | null;
};
```

A run starts `pending` (or `running` with `create({ start: true })`) and ends `completed`, `failed`, `cancelled` or `timed_out`. Every change is a compare-and-set on the status, so a worker, a webhook, a cancel and the deadline sweep can race to settle the same run and exactly one of them wins. A run that ended never changes again: the losing call resolves to `null`.

Everything in the record is JSON and is streamed to whoever follows the run, so keep `meta`, `progress` and `result` small (store an id for anything large), and put in `error` only what a user may read.

## Moving a run along

| Call | From | To | Resolves to |
| --- | --- | --- | --- |
| `Runs.create(options)` | | `pending` (`running` with `start: true`) | the run |
| `Runs.start(id)` | `pending` | `running` | the run, or `null` |
| `Runs.progress(id, { fraction, message, data })` | `pending`, `running` | `running` | the run, or `null` |
| `Runs.complete(id, result?)` | `pending`, `running` | `completed` | the run, or `null` |
| `Runs.fail(id, error)` | `pending`, `running` | `failed` | the run, or `null` |
| `Runs.cancel(id, reason?)` | `pending`, `running` | `cancelled` | the run, or `null` |

`create` takes `kind` (required), and optionally `id`, `subject`, `owner`, `meta`, `deadline` (a duration: milliseconds, or `"30s"`, `"10m"`, `"2h"`) and `start`. Each progress report replaces the last one; `fraction` is between 0 and 1. `fail` takes a message, an `Error` (its message is recorded) or a `{ message, code?, data? }`.

`Runs.get(id)` reads a run, and `Runs.list({ kind, subject, owner, statuses, limit })` finds runs, newest first (at most 50 unless `limit` says otherwise):

```typescript
const [building] = await Runs.list({
  kind: "page-build",
  subject: `site:${site.id}`,
  statuses: ["pending", "running"],
  limit: 1,
});
```

### `Runs.execute`

`Runs.execute(id, fn)` runs `fn` as the run's work. It starts the run, then:

- completes it with what `fn` returns;
- fails it when `fn` throws. A `RunFailure` (from `gemi/services`) is recorded with its message, `code` and `data` as they are. Any other error is logged and recorded as `{ message: "The run failed.", code: "error" }`, so an internal message never reaches the browser;
- aborts `run.signal` when the run is cancelled or passes its deadline while `fn` is still working. Hand the signal to whatever can stop early. `run.progress(...)` does nothing once the run has ended.

It resolves to the run as it ended and does not rethrow, so the queue sees the job succeed and does not retry it. A run that had already ended (cancelled before the job got to it) is returned without calling `fn`. A run that is already `running`, such as one whose earlier job attempt died, is taken up again.

## Waiting and following

`Runs.wait(id, { timeout?, signal? })` resolves once the run has ended, to the run as it ended. With `timeout`, it resolves when the timeout passes to the run as it is then, which may still be open; check `status`. A run past its deadline is timed out by the waiter itself, so a wait never hangs on a worker that died. It rejects with `RunNotFoundError` for an unknown run, and with the signal's reason when `signal` aborts.

`Runs.subscribe(id, { signal? })` follows a run on the server. It yields the run as it is now, then each newer version, and ends after the version that ended the run:

```typescript
for await (const run of Runs.subscribe(runId, { signal })) {
  await notify(run.progress?.message);
}
```

Both are woken by the change feed, and re-read the run every 30 seconds whatever they hear, as a safety net for a lost notification.

## In the browser

`Runs.stream(req, id)` is an SSE response following the run, the same as [`ChangeFeed.stream`](./change-feed.md) on the run's channel. Each event's `data` is the run as it was published. Authorise the read first, like any other route:

```typescript
// app/http/routes/api.ts (Auth and Runs from "gemi/facades")
"/runs/:runId/events": this.get(async (req: HttpRequest<{}, { runId: string }>) => {
  const run = await Runs.get(req.params.runId);
  const user = await Auth.user();
  if (!run || run.owner !== `user:${user.id}`) return new Response(null, { status: 404 });
  return Runs.stream(req, run.id);
}),
```

A view that reads the run passes `Runs.cursor(id)` along with it, so its client starts from what the view showed:

```typescript
return { run, runCursor: await Runs.cursor(run.id) };
```

```tsx
import { useSubscription } from "gemi/client";

const [run, setRun] = useState(initialRun);
useSubscription(
  "/runs/:runId/events",
  { params: { runId: run.id } },
  {
    cursor: runCursor,
    onChange: ({ data }) => setRun((current) => (data.version > current.version ? data : current)),
    onReset: () => refetch(),
  },
);
```

Two instances changing one run at the same moment can publish out of order, so keep the version that is highest, as above.

`Runs.channel(id)` is the run's channel name, `gemi:run:<id>`, for following runs together with other channels through `ChangeFeed` directly.

## Deadlines and housekeeping

A run created with a `deadline` is timed out (`status: "timed_out"`, `error.code: "deadline"`) by whichever comes first: `Runs.wait`, `Runs.execute` on that run, or `Runs.sweep()`. Schedule the sweep so a run whose worker died ends even when nobody waits for it, and prune old runs:

```typescript
// app/cron/RunHousekeeping.ts
import { CronJob } from "gemi/services";
import { Runs } from "gemi/facades";

export class RunHousekeeping extends CronJob {
  name = "RunHousekeeping";
  cron = CronJob.exp("* * * * *");

  async callback() {
    await Runs.sweep(); // times out overdue runs, at most `sweepLimit` (500) per call
    await Runs.prune("7d"); // deletes runs that ended more than 7 days ago
  }
}
```

## Stores

Configure the store in `app/config/runs.ts`:

```typescript
import { defineRunsConfig } from "gemi/services";

export default defineRunsConfig({
  store: "database", // "memory" (default) | "database" | a RunStore | (app) => RunStore
});
```

- **`"memory"`** (default) keeps runs in a map for as long as the process lives. It is not durable, and only works when the work runs in the same process (the memory queue driver). Use it in development and tests.
- **`"database"`** keeps runs in the `gemi_runs` table of the default connection (`DatabaseRunStore`), on SQLite, Postgres and MySQL. Times come from the database's clock, so every instance agrees on when a run is overdue. Inside an ORM transaction on that connection the store writes on the transaction, so a `Runs.create` and a database-queue `Job.dispatch` in one transaction commit together or not at all, and the change feed holds the run's publish until the commit.

The table, as a Prisma model:

```prisma
model GemiRun {
  id         String  @id
  kind       String
  subject    String?
  owner      String?
  status     String
  meta       String?
  progress   String?
  result     String?
  error      String?
  version    Int     @default(1)
  createdAt  BigInt  @map("created_at")
  startedAt  BigInt? @map("started_at")
  updatedAt  BigInt  @map("updated_at")
  finishedAt BigInt? @map("finished_at")
  deadlineAt BigInt? @map("deadline_at")

  @@index([subject, createdAt])
  @@index([status, deadlineAt])
  @@map("gemi_runs")
}
```

On MySQL, add `@db.LongText` to `meta`, `progress`, `result` and `error`. Without Prisma, `await new DatabaseRunStore(connection).createTable()` creates the same table and indexes if they do not exist, and `new DatabaseRunStore(connection, { table })` picks another table name.

**Across instances**, waiting needs a change feed every instance shares: the feed's `database` driver (see [Change Feeds](./change-feed.md#drivers)). With the default memory feed, a waiter on another instance still sees the run end, but only at its 30-second re-read.

A `RunStore` of your own implements `create`, `get`, `list`, `transition` (a compare-and-set on the status that bumps `version`), `overdue`, and optionally `now` and `prune`. See `MemoryRunStore` for the contract.

## Runs and other background work

- **Queue jobs** stay as they are: a job takes a `runId` and calls `Runs.execute` (or `Runs.progress` / `Runs.complete` itself).
- **Workflows and batches** keep their own records. A run can wrap one: `meta: { workflowId }`, completed from the workflow's last step.
- **Agent background jobs** (`ctx.jobs`, see [AI Background Jobs](./ai-background-jobs.md)) keep their own store, which feeds the tool result back into the thread.
