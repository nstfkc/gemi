---
title: Know Which Directories Are Discovered and Which Need Declaring
impact: HIGH
impactDescription: the difference between code that runs and code that silently never does
tags: structure, discovery, kernel, registration
---

## Know Which Directories Are Discovered and Which Need Declaring

`app/` has two kinds of directory, and confusing them produces the same symptom
either way: code that looks correct, imports cleanly, typechecks, and never runs.

**Discovered — writing the file *is* the registration:**

| Directory | Base class | Read at |
|---|---|---|
| `app/cron/` | `CronJob` | boot |
| `app/jobs/` | `Job` | boot |
| `app/listeners/` | `Listener` | boot |
| `app/commands/` | `defineCommand` chains | `gemi run` only |

Nothing anywhere names these. Adding a `Job` subclass under `app/jobs/` registers
it; there is no list to append to, and appending to one you invented does nothing.

`app/listeners/` is the one the scaffold does not create — its absence is not an
error, it means the app has no listeners yet.

**Declared — the file is not enough:**

- **Models** are declared on the Kernel. A model class under `app/models/` that
  the Kernel's `models` does not reach is not registered, and `gemi check models`
  exists to report exactly that gap for policied models.
- **Routers** are registered explicitly — `app/http/routes/view.ts` and `api.ts`
  are the roots, and a new router is reached by being mounted from one of them.
- **Config slices** under `app/config/` are named by the Kernel's `config`.
- **Service providers** under `app/providers/` are named by the Kernel's
  `providers`.

**Incorrect (a job that never runs, because a hand-rolled list is not the mechanism):**

```ts
// app/jobs/index.ts — invented; nothing reads this
export const jobs = [SendWelcomeEmail, ReindexProducts];
```

**Correct (the file is the registration):**

```ts
// app/jobs/SendWelcomeEmail.ts
export class SendWelcomeEmail extends Job {
  static token = "SendWelcomeEmail";
  // …
}
```

**Incorrect (a model that typechecks and is never registered):**

```ts
// app/models/Invoice.ts — written, but not reachable from the Kernel's `models`
export class Invoice extends Model {}
```

The four discovered directories have a cost worth knowing: **discovery imports
every file it walks**, because a class does not exist until its module has run. A
file in one of them that does work at import time does that work at boot. Keep
them to declarations — see `service-lazy-not-module-scope`.

The discovered directories can also be declared explicitly in their config slice
(`schedule`, `queue`, `events`, `command`), which turns the walk off and uses the
list verbatim. An empty array is a declaration too, and means "this app has none"
— not "fall back to walking".
