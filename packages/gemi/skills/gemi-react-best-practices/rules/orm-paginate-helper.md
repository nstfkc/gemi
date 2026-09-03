---
title: Use paginate() From gemi/orm, and Know Its Ceiling
impact: MEDIUM
impactDescription: bounded reads, no unbounded scans
tags: orm, pagination, validation
---

## Use paginate() From gemi/orm, and Know Its Ceiling

An unbounded list read is a slow query waiting for the row count to grow. `paginate`
validates and clamps request input in one place rather than each controller
hand-rolling `parseInt` and a guard.

```ts
import { paginate } from "gemi/orm";

const { take, skip } = paginate({
  page: req.search.get("page"),
  perPage: req.search.get("perPage"),
});
```

Its behaviour, which you must design around:

- Absent, blank or non-finite values are treated as absent.
- `perPage` **defaults to 25 and is capped at 100**.
- `page` clamps to a minimum of 1.

**The 100-row cap is the trap.** A caller that asks for `limit=200` silently gets
100 — half its data, no error. If a surface genuinely needs more, it must paginate
rather than raise the number.

**Incorrect (unbounded, and it will not stay fast):**

```ts
const products = await Product.findMany({ where: { organizationId } });
```

**Incorrect (hand-rolled, and unvalidated `take` is refused rather than coerced):**

```ts
const take = Number(req.search.get("limit"));
const products = await Product.findMany({ where, take });
```

**Correct:**

```ts
const { take, skip } = paginate({
  page: req.search.get("page"),
  perPage: req.search.get("perPage"),
});
const products = await Product.findMany({
  where: { organizationId },
  take,
  skip,
  orderBy: { createdAt: "desc" },
});
```

Two related ORM behaviours: `take` and `skip` must be integers and are **refused,
not coerced** — a negative `take` means "the last N rows". And an `update` with
`data: {}` reads rather than writes, returning the row unchanged.

A deliberately unpaginated read is a decision worth a comment saying why (see
`CustomerProductsV2Controller`).

Reference: <https://nstfkc.github.io/gemi/orm.md>
`app/http/controllers/AdminMediaController.ts`
