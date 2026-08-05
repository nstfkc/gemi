# Cron

Cron jobs run code on a recurring schedule — nightly reports, hourly cleanups, periodic audits — without any incoming request. You define each one as a class extending `CronJob` (from `gemi/services`) in a file under `app/cron/`, and gemi schedules it in-process using `Bun.cron`. Nothing else is needed — the directory is read at boot.

## Defining a cron job

A cron job needs a unique `name`, a `cron` schedule expression, and a `callback` that does the work. Put each job in its own module under `app/cron/`.

```typescript
// app/cron/DailyDigest.ts
import { CronJob } from "gemi/services";
import { prisma } from "@/app/database/prisma";

export class DailyDigest extends CronJob {
  name = "DailyDigest";
  cron = CronJob.exp("@daily");

  async callback() {
    const users = await prisma.user.findMany({ select: { email: true } });
    // ...build and send the digest...
  }
}
```

That file is the whole registration — there is no list to add it to. **Registering jobs**, below, covers how the directory is read and how to take registration over yourself.

Fields and hooks on `CronJob`:

| Member | Type | Description |
| --- | --- | --- |
| `name` | `string` | Unique job name. Required — a job without a name is skipped with an error. Also used as the registry key so a hot reload updates the job in place instead of stacking duplicates. |
| `cron` | `CronExpression` | The schedule. Required — a job without an expression is skipped. |
| `shouldRun()` | `() => boolean \| Promise<boolean>` | Optional gate, evaluated once per tick before anything else. Returns `true` by default; returning `false` skips the whole tick — `onTick()`, `callback()` and `onComplete()` alike. See **Skipping a tick**, below. |
| `callback()` | `() => void \| Promise<void>` | The work to run on each tick. |
| `onTick()` | `() => void \| Promise<void>` | Optional hook run immediately before `callback()` — sequentially, not alongside it. |
| `onComplete()` | `() => void \| Promise<void>` | Optional hook run after `callback()` finishes, whether it returned or threw. |

Each tick re-enters the application context, so a job body resolves services exactly like a request handler does — `prisma`, `Email`, the `Storage`/`Log`/`Lang` facades, `Job.dispatch`, or anything you resolve yourself with `app(SomeService)`. Scheduling happens in `ScheduleServiceProvider.boot()`, which runs after every provider has registered, so any binding the container holds is available by the time a job first ticks. Errors thrown in `shouldRun`, `onTick`, `callback`, or `onComplete` are caught and logged rather than crashing the scheduler — with one difference: a `shouldRun` that throws also skips the tick, while the other three log and carry on to the next hook.

## Schedule expressions — `CronJob.exp(...)`

`CronJob.exp(expression)` is a typed helper that returns the expression string it's given. Its only job is to surface the supported nicknames in editor autocomplete while still accepting any raw expression — assigning to `cron` directly works identically. The expression is passed straight to `Bun.cron`.

A `cron` value is either a **standard 5-field expression** or one of the **nicknames** below.

### 5-field expressions

```
┌───────────── minute (0–59)
│ ┌───────────── hour (0–23)
│ │ ┌───────────── day of month (1–31)
│ │ │ ┌───────────── month (1–12)
│ │ │ │ ┌───────────── day of week (0–6, Sunday = 0)
│ │ │ │ │
* * * * *
```

```typescript
cron = CronJob.exp("0 9 * * *");    // every day at 09:00
cron = CronJob.exp("*/15 * * * *"); // every 15 minutes
cron = CronJob.exp("0 0 * * 1");    // every Monday at 00:00
```

Standard field syntax is supported: `*`, ranges (`1-5`), steps (`*/10`), and lists (`1,15,30`).

> **Note:** Cron expressions are interpreted in **UTC**, not the server's local timezone. `"0 9 * * *"` fires at 09:00 UTC. Account for the offset when a job needs to run at a specific local time.

### Nicknames

| Nickname | Equivalent |
| --- | --- |
| `@yearly` / `@annually` | Once a year, Jan 1 at 00:00 |
| `@monthly` | First day of the month at 00:00 |
| `@weekly` | Every Sunday at 00:00 |
| `@daily` / `@midnight` | Every day at 00:00 |
| `@hourly` | Every hour, on the hour |

```typescript
cron = CronJob.exp("@daily");
cron = CronJob.exp("@hourly");
```

> **Note:** Only the nicknames above and standard 5-field expressions are valid — they are handled by `Bun.cron`. Extended shortcuts you may see in older gemi apps (e.g. `@at_9:00`, `@every_5_minutes`, `@on_monday`, `@between_9_17`) came from gemi's previous custom cron engine and are **not** understood by the current `Bun.cron`-based scheduler. Translate them to standard expressions — for example `@at_9:00` becomes `"0 9 * * *"` (09:00 UTC), and `@every_5_minutes` becomes `"*/5 * * * *"`.

## Skipping a tick — `shouldRun()`

`shouldRun()` decides whether a tick happens at all. It is evaluated once per tick, before anything else, and returning `false` skips `onTick()`, `callback()` and `onComplete()` alike. The default returns `true`, so a job that says nothing about it behaves exactly as it always did.

```typescript
// app/cron/StorageAlert.ts
import { CronJob } from "gemi/services";

export class StorageAlert extends CronJob {
  name = "StorageAlert";
  cron = CronJob.exp("0 9 * * *");

  shouldRun() {
    return process.env.NODE_ENV === "production";
  }

  async callback() {
    // ...check remaining capacity and page whoever is on call...
  }
}
```

The reason this is a member rather than a line at the top of `callback` is that `onTick` and `onComplete` are called *outside* `callback`, so a guard written inside `callback` only stops the work. A job that reports outward — mails a digest, opens a Sentry issue, pings a channel — usually announces itself in `onTick` and `onComplete`, and those would still fire from a laptop. `shouldRun()` is the one place that covers a whole tick.

**It gates work, not registration.** A job whose gate returns `false` is still scheduled, still holds its `Bun.cron` handle, and still appears in `scheduler.jobs`. "Is it scheduled" and "will it do anything" are different questions, and the second is answered fresh on every tick — which is also why this is a method. A field would be read once, when the scheduler constructs the job at boot, and would freeze whatever it saw then.

**A gate that throws skips the tick**, and the error is logged. A gate that failed has said nothing about whether the job may run, and the two wrong answers are not the same size: a skipped tick of recurring work comes back on the next tick, an email sent from the wrong machine does not come back at all.

**Nothing calls `super` for you.** Writing the gate once on a base class that several jobs share is the ordinary case, and a subclass that overrides `shouldRun()` for a reason of its own silently drops whatever the base was gating on. Narrow rather than redefine:

```typescript
// app/support/AlertingCronJob.ts
import { CronJob } from "gemi/services";

export abstract class AlertingCronJob extends CronJob {
  shouldRun(): boolean | Promise<boolean> {
    return process.env.NODE_ENV === "production";
  }
}
```

> **Keep a shared base out of `app/cron`.** `abstract` is a TypeScript idea and is gone by the time the scheduler runs, so a base class sitting in the discovered directory is a class extending `CronJob` like any other: it is found, constructed, and — having no `name` — rejected on every boot with `Cron job must have a name`. It also lands in `scheduler.jobs`, which breaks the very assertion **Asking what is scheduled**, below, suggests writing. Any directory outside the walk will do — the template ships no particular home for this, and `app/support/` is just what these snippets picked.

Annotate the return type on a shared base rather than letting it be inferred. A base that returns a plain `boolean` narrows the signature its subclasses inherit, and a subclass that needs to `await super.shouldRun()` has to be `async` — which TypeScript then rejects against the narrowed base. Writing the type `CronJob` declares keeps both spellings open.

```typescript
// app/cron/WeeklyRevenue.ts
import { AlertingCronJob } from "@/app/support/AlertingCronJob";
import { CronJob } from "gemi/services";

export class WeeklyRevenue extends AlertingCronJob {
  name = "WeeklyRevenue";
  cron = CronJob.exp("0 8 * * 1");

  async shouldRun() {
    return (await super.shouldRun()) && (await this.hasSubscribers());
  }

  async hasSubscribers() {
    // ...
    return true;
  }

  async callback() {
    // ...build and send the report...
  }
}
```

Note what the subclass keeps: `callback`, the name the rest of this page teaches. Holding only the gate is all the base class is for. Without `shouldRun()`, the only base class that could gate a job was one that shadowed `callback` itself:

```typescript
// the shape this replaces — don't write it
export abstract class GatedCronJob extends CronJob {
  abstract run(): Promise<void>;

  async callback() {
    if (process.env.NODE_ENV !== "production") return;
    await this.run();
  }
}
```

That works, and it costs the app the framework's own vocabulary: a job under it reads `async run()` while every page of this documentation reads `async callback()`. The next person to follow the docs writes a `callback`, the base class overrides it, and the job silently does nothing — no error, no output, nothing to notice. It also never reached `onTick` and `onComplete`, which the scheduler calls outside `callback`.

## Registering jobs — `app/cron/`

Cron jobs are discovered. Every class under `app/cron` that extends `CronJob` is scheduled when the kernel boots, so writing the file is all it takes — there is no list to keep in step with it.

That is deliberate, and it is about the failure that happens when the two disagree. A cron job that is written and never listed fires never, and unlike a dropped request there is nothing downstream waiting to notice: the report simply stops arriving, for as long as it takes somebody to ask why they stopped seeing it.

```typescript
// app/cron/ProductCreationReport.ts
import { CronJob } from "gemi/services";

export class ProductCreationReport extends CronJob {
  name = "ProductCreationReport";
  cron = CronJob.exp("0 9 * * *"); // daily at 09:00 UTC

  async callback() {
    // ...gather metrics and email the report...
  }
}
```

```typescript
// app/cron/SubscriptionAudit.ts
import { CronJob } from "gemi/services";

export class SubscriptionAudit extends CronJob {
  name = "SubscriptionAudit";
  cron = CronJob.exp("0 8 * * *"); // daily at 08:00 UTC

  async callback() {
    // ...read-only audit + alert...
  }
}
```

Both are scheduled. Neither is mentioned anywhere else.

### Two jobs, one name

`name` is the scheduler's key, so only one job can hold it. If two claim the same one, the first is scheduled and the second is refused with both class names on stderr — a directory walk makes this easy to write by accident, since `billing/DailyReport.ts` and `analytics/DailyReport.ts` never have to appear side by side the way two entries in a list would.

Both still appear in `scheduler.jobs`, which reports what the scheduler was handed rather than what it accepted, so a test walking the schedule sees the clash instead of a tidied-up set.

### What the walk costs

A class does not exist until its module has run, so there is no way to read a directory of classes without importing it. **Every `.ts`/`.tsx` file under `app/cron` is imported at boot** — in development and in production, on every start — and a file that *does something* when it is imported does that thing at boot. A module that opens a connection, seeds a cache, or registers a listener at the top level is doing it before the first request, from a directory nobody thought of as an entry point.

So `app/cron` wants to hold cron declarations rather than merely contain some. Keep a helper that runs work on import somewhere else, or list the jobs explicitly (below) and skip the walk entirely. A file that cannot be imported at all — one reaching a `?raw` or `.css` specifier through its imports, say — fails the boot naming itself, rather than being quietly left out of the schedule.

The walk takes every class that extends `CronJob`, and `abstract` does not survive to runtime — so a shared base class belongs outside this directory too. See **Skipping a tick**, above, where that is the pattern most likely to tempt you into writing one.

The walk skips what certainly is not a declaration: `.d.ts` files, tests, type tests and benchmarks by their filename suffix, dot-directories, `node_modules`, and anything under a directory carrying its own `package.json`. Nothing else is guessed at.

A new file is picked up on the next server reload — under `gemi dev`, creating a file does not by itself trigger one, so save any other file (or restart) if a job you just wrote has not appeared.

### Listing them explicitly — `app/config/schedule.ts`

Declaring `jobs` in the `schedule` config slice turns discovery off and uses your list verbatim. Reach for it when the jobs live somewhere the walk cannot reach, when you want a deliberate subset, or when the deploy ships only the build output and there is no `app/cron` on disk to read.

```typescript
// app/config/schedule.ts
import { defineScheduleConfig } from "gemi/services";
import { ProductCreationReport } from "@/app/cron/ProductCreationReport";
import { SubscriptionAudit } from "@/app/cron/SubscriptionAudit";

export default defineScheduleConfig({
  jobs: [ProductCreationReport, SubscriptionAudit],
});
```

`defineScheduleConfig` is an identity helper — it exists only to type the object.

**A present `jobs` wins, and `jobs: []` is present.** An empty array means an application with nothing scheduled and is honoured as such; it does not mean "go and find some". Leaving the key out — or leaving the slice out entirely — is what asks for discovery.

The file is wired into the kernel by name:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import schedule from "../config/schedule";

export default class extends Kernel {
  config = { schedule /* , ...other slices */ };
}
```

| Config key | Field | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `schedule` | `jobs` | `(new () => CronJob)[]` | *discovered* | The scheduled job classes. Omit to discover them from `jobsDir`. |
| `schedule` | `jobsDir` | `string` | `"app/cron"` | Where to discover them. Relative to the project root, or absolute. |

See [Project Structure](./project-structure.md) for the full kernel layout.

> **Coming from Laravel:** the vocabulary is the same — a `ServiceProvider` registers bindings into the `Container`, config lives in `app/config`, and facades are static proxies to container-resolved services. One thing is deliberately different: gemi has no `Schedule::command(...)` macro called from a provider's `boot()`. Recurring work is declared as `CronJob` classes under `app/cron`, and per-subsystem hooks (`filterRecipients`, `onLogCreated`, `detectLocale`, ...) are **config callbacks** in `app/config/*.ts` rather than things you register from `boot()`. `boot()` is for wiring you cannot express as data.

### Resolving the scheduler

`Scheduler` is a normal container binding (token `"scheduler"`), so you can resolve it if you need the handles:

```typescript
import { app } from "gemi/foundation";
import { Scheduler } from "gemi/services";

app(Scheduler); // typed Scheduler, no cast
```

### Asking what is scheduled

`scheduler.jobs` is the set the scheduler took — discovered or declared, whichever the slice asked for. Reach for it in a test that wants to assert something about the whole schedule (that every report has an owner, that no two share an expression), which used to be written by importing the `jobs` array from the config module:

```typescript
import { app } from "gemi/foundation";
import { Scheduler } from "gemi/services";

for (const Job of app(Scheduler).jobs) {
  const job = new Job();
  expect(job.name).toBeTruthy();
}
```

`discoverCronJobs()` answers the same question without an application around it — it walks `app/cron` (or a directory you name) and returns the classes it finds. `discoverJobs()` is its counterpart for the queue. Both import every file they walk, so calling one runs the app's cron modules the same way boot does.

```typescript
import { discoverCronJobs } from "gemi/services";

const jobs = await discoverCronJobs(); // every CronJob subclass under app/cron
```

> **Note:** Cron jobs run **in-process** in the server. Every running server instance registers and fires its own schedule, so if you run multiple replicas, a job scheduled `@daily` fires once per replica per day. For work that must run exactly once across a fleet, add your own coordination (e.g. an advisory lock) inside `callback`.

## Cron jobs vs. queued jobs

Use a **cron job** for time-based, recurring work that runs on its own schedule. Use a **queued job** for work triggered by a request that you want to run in the background. The two compose well — a cron `callback` often dispatches queued jobs to fan work out. See [Jobs & Queues](./jobs-and-queues.md).

## Related

- [Jobs & Queues](./jobs-and-queues.md) — background work triggered on demand.
- [Project Structure](./project-structure.md) — the kernel, `app/config/*.ts`, and service providers.
- [Configuration](./configuration.md) — environment setup.
