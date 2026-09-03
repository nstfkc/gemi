---
title: Heavy Aggregations Run on a Separate Connection
impact: HIGH
impactDescription: keeps the request-path pool available
tags: orm, connections, pooling, admin, cron
---

## Heavy Aggregations Run on a Separate Connection

Every connection your app declares counts against the database server's connection
budget, and a long admin scan or cron aggregation on the same pool that serves
requests starves the every-request auth path. This is a common production incident
shape, not a hypothetical.

If your app declares a second connection for that work — the usual name is
`analytics` — route heavy reads to it. **Selection is per query, never per model:**

```ts
await AuditLog.on("analytics").count({ where });
await DB.connection("analytics").query(sql`…`);
```

**Incorrect (a full-table admin scan competing with request traffic):**

```ts
const rows = await AuditLog.findMany({
  where: { createdAt: { gte: monthStart } },
});
```

**Correct:**

```ts
const rows = await AuditLog.on("analytics").findMany({
  where: { createdAt: { gte: monthStart } },
});
```

`Model.on(name)` and `DB.connection(name)` both take a connection your app has
declared in its database config. There is no framework-provided `analytics` pool —
check what your app actually declares before reaching for a name.

**Bound a batch's concurrency to the pool that serves it.** An unbounded
`Promise.all` over a three-connection pool is a queue, not parallelism, and it is a
queue that blocks anything else needing that pool. Cap the in-flight count at the
pool size rather than fanning out over the whole collection.

**Do not hardcode a pool size at a call site.** Read it from the same config that
declares the pool, so shrinking the pool cannot leave a batch fanning out wider than
it can serve.

Remember `orm-transaction-sequential`: a transaction cannot span connections, so
work inside `Model.transaction` stays on the connection that opened it.
