# Cron

Cron jobs run code on a recurring schedule — nightly reports, hourly cleanups, periodic audits — without any incoming request. You define each one as a class extending `CronJob` (from `gemi/services`) and register it on your app's `CronServiceProvider`. gemi schedules them in-process using `Bun.cron`.

## Defining a cron job

A cron job needs a unique `name`, a `cron` schedule expression, and a `callback` that does the work.

```typescript
// app/kernel/providers/CronServiceProvider.ts
import { CronJob, CronServiceProvider } from "gemi/services";
import { prisma } from "@/app/database/prisma";

class DailyDigest extends CronJob {
  name = "DailyDigest";
  cron = CronJob.exp("@daily");

  async callback() {
    const users = await prisma.user.findMany({ select: { email: true } });
    // ...build and send the digest...
  }
}

export default class extends CronServiceProvider {
  jobs = [DailyDigest];
}
```

Fields and hooks on `CronJob`:

| Member | Type | Description |
| --- | --- | --- |
| `name` | `string` | Unique job name. Required — a job without a name is skipped with an error. Also used as the registry key so a hot reload updates the job in place instead of stacking duplicates. |
| `cron` | `CronExpression` | The schedule. Required — a job without an expression is skipped. |
| `callback()` | `() => void \| Promise<void>` | The work to run on each tick. |
| `onTick()` | `() => void \| Promise<void>` | Optional hook run alongside each tick. |
| `onComplete()` | `() => void \| Promise<void>` | Optional hook run when the tick's work completes. |

Each tick runs inside the app's kernel context (after boot), so facades and services — `prisma`, `Email`, `FileStorage`, `Job.dispatch`, etc. — are available inside `callback`. Errors thrown in `callback`, `onTick`, or `onComplete` are caught and logged rather than crashing the scheduler.

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

## Registering jobs — `CronServiceProvider`

List every cron job class on your app's `CronServiceProvider`. They are scheduled automatically when the kernel boots.

```typescript
// app/kernel/providers/CronServiceProvider.ts
import { CronJob, CronServiceProvider } from "gemi/services";

class ProductCreationReport extends CronJob {
  name = "ProductCreationReport";
  cron = CronJob.exp("0 9 * * *"); // daily at 09:00 UTC

  async callback() {
    // ...gather metrics and email the report...
  }
}

class SubscriptionAudit extends CronJob {
  name = "SubscriptionAudit";
  cron = CronJob.exp("0 8 * * *"); // daily at 08:00 UTC

  async callback() {
    // ...read-only audit + alert...
  }
}

export default class extends CronServiceProvider {
  jobs = [ProductCreationReport, SubscriptionAudit];
}
```

The provider's only field is `jobs` — an array of `CronJob` subclasses. See [Project Structure](./project-structure.md) for how the provider is registered in the kernel.

> **Note:** Cron jobs run **in-process** in the server. Every running server instance registers and fires its own schedule, so if you run multiple replicas, a job scheduled `@daily` fires once per replica per day. For work that must run exactly once across a fleet, add your own coordination (e.g. an advisory lock) inside `callback`.

## Cron jobs vs. queued jobs

Use a **cron job** for time-based, recurring work that runs on its own schedule. Use a **queued job** for work triggered by a request that you want to run in the background. The two compose well — a cron `callback` often dispatches queued jobs to fan work out. See [Jobs & Queues](./jobs-and-queues.md).

## Related

- [Jobs & Queues](./jobs-and-queues.md) — background work triggered on demand.
- [Project Structure](./project-structure.md) — registering `CronServiceProvider`.
- [Configuration](./configuration.md) — environment setup.
