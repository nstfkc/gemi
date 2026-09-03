---
title: Never Promise.all ORM Calls Inside a Transaction
impact: HIGH
impactDescription: prevents deadlock and lost writes
tags: orm, transactions, concurrency, correctness
---

## Never Promise.all ORM Calls Inside a Transaction

`Model.transaction(fn)` is **ambient** — it uses `AsyncLocalStorage`, so nothing
takes a `tx` parameter and every ORM query in the async subtree joins the
transaction automatically. That convenience has a hard constraint: the transaction
holds **one reserved connection**, so concurrent queries inside the callback are not
safe. Await them in sequence.

This is the one place that overrides `payload-parallel-controller-work`: everywhere
else independent awaits belong in a `Promise.all`, but inside a transaction callback
sequential is correct.

**Incorrect (concurrent queries on one reserved connection):**

```ts
await Order.transaction(async () => {
  await Promise.all([
    Order.update({ where: { id }, data: { status } }),
    OrderItem.createMany({ data: items }),
    AuditLog.create({ data: entry }),
  ]);
});
```

**Correct (sequential):**

```ts
await Order.transaction(async () => {
  await Order.update({ where: { id }, data: { status } });
  await OrderItem.createMany({ data: items });
  await AuditLog.create({ data: entry });
});
```

**A failed statement aborts the whole Postgres transaction block.** Catching an
error and continuing loses everything after it. Wrap a fallible step in a nested
transaction — nesting creates a savepoint, so an inner failure rolls back to the
savepoint and leaves the outer transaction usable:

```ts
await Model.transaction(async () => {
  try {
    await Model.transaction(() => User.create({ data: { email } }));
  } catch {
    // recovery
  }
  await Audit.create({ data: entry }); // still safe
});
```

**A transaction cannot span connections.** Crossing pools inside one raises
`CrossConnectionTransactionError`, and it cannot span the ORM and Prisma clients
either — they are separate pools. That is why the credit-settlement cluster stays
entirely on Prisma; see `CLAUDE.md` → "The Prisma boundary is
transactional, not directory-shaped."

Reference: <https://nstfkc.github.io/gemi/orm.md>
