---
title: Keep Network I/O Out of a Transaction Callback
impact: HIGH
impactDescription: frees a pooled connection held for a network round-trip
tags: orm, transactions, pooling, io
---

## Keep Network I/O Out of a Transaction Callback

The reserved connection is held for the **entire** duration of the callback. An HTTP
call, an upload, a queue push or an LLM request inside a transaction holds a pooled
connection for as long as that request takes — and under load, unrelated queries
elsewhere in the app queue behind it. The pools here are small and budgeted
(your database config's pool sizes are asserted against a per-instance
budget at boot), so one slow callback is felt app-wide.

Do the I/O first, or after. Keep the transaction to the writes that must be atomic.

**Incorrect (a connection held across a third-party API call):**

```ts
await Order.transaction(async () => {
  const order = await Order.create({ data });
  const charge = await stripe.charges.create({ amount });   // network
  await Storage.put(`receipts/${order.publicId}.pdf`, pdf); // network
  await Order.update({ where: { id: order.id }, data: { chargeId: charge.id } });
});
```

**Correct (I/O outside; the transaction is the atomic write only):**

```ts
const charge = await stripe.charges.create({ amount });

const order = await Order.transaction(async () => {
  const created = await Order.create({ data });
  await Order.update({
    where: { id: created.id },
    data: { chargeId: charge.id },
  });
  return created;
});

await Storage.put(`receipts/${order.publicId}.pdf`, pdf);
```

**Deferred work belongs in a Job**, not in the callback. `Job.dispatch(...)` from
`app/jobs` enqueues and returns `void`, so the request path never waits on it.

One caveat from `CLAUDE.md`: the queue runs in-process, and the cron
scheduler does not start under `gemi run`. A **command** that dispatches a Job may
exit before it runs — do that work inline instead.

Reference: <https://nstfkc.github.io/gemi/orm.md>
