---
title: Services and Jobs Need a Static String Identifier
impact: HIGH
impactDescription: works in dev, silently breaks in the production build
tags: service, jobs, minification, production
---

## Services and Jobs Need a Static String Identifier

A `Service` needs `static token`; a `Job` needs `static name`. Both are string
literals because **minification renames classes in the production build** — the
container key and the queue's dispatch name must survive that rename. This is a
class of bug that cannot reproduce locally: dev is unminified, so everything works
until it is deployed.

**Incorrect (relies on the class name surviving the build):**

```ts
export class ProcessVideoJob extends Job {
  async run(params: Params) { /* … */ }
}
```

**Correct:**

```ts
export class ProcessVideoJob extends Job {
  static name = "ProcessVideoJob";
  maxAttempts = 3;

  async run(params: Params) { /* … */ }
  onFail(error: Error, params: Params) { /* … */ }
  onDeadletter(error: Error, params: Params) { /* … */ }
}

export class Billing extends Service {
  static token = "Billing";
}
```

- **Tokens must be unique.** Two jobs claiming one name: the framework refuses the
  second with a line on stderr rather than silently dropping it — rename one.
- **`maxAttempts` defaults to 3.** `run` throwing calls `onFail` and requeues;
  the final failure calls `onDeadletter` and drops the job.
- **`worker: true`** runs the job in a separate Worker thread, for CPU-bound work.
- **Dispatch is fire-and-forget** — `Job.dispatch(payload)` returns `void`. Pass only
  serializable data, never a class instance or a function.

**Register services explicitly on `Kernel.services`, and note that boot order is
load-bearing** — a service listed first boots before those after it.

<https://nstfkc.github.io/gemi/jobs-and-queues.md>
