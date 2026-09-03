---
title: The Queue Is In-Process and In-Memory — Do Not Trust It With Durable Work
impact: HIGH
impactDescription: enqueued work is lost on restart
tags: service, jobs, queue, durability
---

## The Queue Is In-Process and In-Memory — Do Not Trust It With Durable Work

Jobs live in the server process's memory. **Enqueued jobs do not survive a restart**,
and there is no cross-machine queue — a job dispatched on one instance runs on that
instance or not at all. Use jobs for best-effort work: warming a cache, sending a
non-critical email, kicking off media processing that the user can retry.

Anything that must not be lost needs a durable record: write the row first, then let
the job (or a cron sweep) act on it, so a restart leaves work to pick up rather than
a gap.

**Incorrect (the only record of the charge lives in the queue):**

```ts
async store(req: HttpRequest) {
  const order = await Order.create({ data });
  SettleOrderJob.dispatch({ orderId: order.publicId }); // lost on deploy
  return { order };
}
```

**Correct (durable state first; the job is an accelerator):**

```ts
async store(req: HttpRequest) {
  const order = await Order.create({ data: { ...data, settlementStatus: "pending" } });
  SettleOrderJob.dispatch({ orderId: order.publicId });
  return { order };
}
// A cron sweeps `settlementStatus: "pending"` rows, so a lost dispatch self-heals.
```

**Two deployment-shaped constraints that follow:**

- **The `queue` and `schedule` config slices declare their `jobs` lists
  explicitly, and must keep doing so.** Discovery is a *runtime* filesystem walk, and
  the release image ships only `dist/` — there is no `app/jobs` or `app/cron` on disk
  in production. Discovery there warns once and registers nothing, so every job and
  cron would stop running while dev and CI stayed green. Note `jobs: []` is
  *present* and disables everything; omitting the key is what enables discovery.
- **A command dispatching a Job may exit before it runs.** The queue runs in-process
  and the cron scheduler does not start under `gemi run` — do that work inline in the
  command instead.

Reference: <https://nstfkc.github.io/gemi/jobs-and-queues.md>
