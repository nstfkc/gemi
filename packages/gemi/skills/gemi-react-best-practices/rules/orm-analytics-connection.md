---
title: Heavy Aggregations Run on the Analytics Pool
impact: HIGH
impactDescription: keeps the request-path pool available
tags: orm, connections, pooling, admin, cron
---

## Heavy Aggregations Run on the Analytics Pool

This app runs **four pools per instance** — a hot pool and an analytics pool on
each of the ORM and Prisma clients — and every pool counts separately against the
server's connection budget. A long admin scan or cron aggregation on the hot pool
starves the every-request auth path. This is a common production incident shape, not
a hypothetical.

Route heavy reads to the analytics connection. **Selection is per query, never per
model:**

```ts
await WebhookEventLog.on("analytics").count({ where });
await DB.connection("analytics").query(sql`…`);
```

**Incorrect (a full-table admin scan competing with request traffic):**

```ts
const rows = await AIAssistantChat.findMany({
  where: { createdAt: { gte: monthStart } },
});
```

**Correct:**

```ts
const rows = await AIAssistantChat.on("analytics").findMany({
  where: { createdAt: { gte: monthStart } },
});
```

**Bound the concurrency of a batch to the pool that serves it.** The admin batches
use `mapWithConcurrency` capped at `ANALYTICS_POOL_SIZE` (exported from
`app/config/database.ts`) precisely so a batch cannot queue more work than the pool
can serve. An unbounded `Promise.all` over a 3-connection pool is a queue, not
parallelism.

**Do not hardcode a pool size.** All four sizes resolve through
`app/config/databasePools.ts` (`poolSizes`), which holds the shared per-instance
budget and a boot-time assertion that the four shares sum to at most that budget.
A literal size in a config file escapes the assertion — that is the #751/#772
footgun, and the 2026-08-10 pool-shrink incident.

Remember `orm-transaction-sequential`: a transaction cannot span connections.
