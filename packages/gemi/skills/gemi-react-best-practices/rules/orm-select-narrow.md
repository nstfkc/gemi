---
title: Select the Columns the Response Actually Serializes
impact: MEDIUM
impactDescription: less data over two wires
tags: orm, select, payload, serialization
---

## Select the Columns the Response Actually Serializes

Every unselected column crosses two wires: database → server, then server → browser
in the SSR payload or the API response. Narrowing at the query removes both, and
prevents internal columns from leaking into a payload anyone can read.

This is the query-side half of `payload-minimal-view-props`.

**Incorrect (loads every column of every row, then renders three fields):**

```ts
const products = await Product.findMany({
  where: { organizationId },
  include: { media: true },
});
return products.map((p) => ({ id: p.publicId, name: p.name, cover: p.media[0] }));
```

**Correct (narrow the tree at the query, including inside the relation):**

```ts
const products = await Product.findMany({
  where: { organizationId },
  select: {
    publicId: true,
    name: true,
    media: { select: { url: true }, take: 1 },
  },
});
```

Note `take: 1` inside the relation is **per parent** (`orm-include-not-n-plus-one`),
which is what you want for a cover image.

**Prefer `count` / `aggregate` over loading rows to count them:**

```ts
// Incorrect
const orders = await Order.findMany({ where: { status: "pending" } });
const pending = orders.length;

// Correct
const pending = await Order.count({ where: { status: "pending" } });
```

But note the counterpart from the ORM docs: a `_count` node makes the lateral
strategy decline for that node and its descendants, and an unindexed `_count`
compiles to a correlated subquery per parent row. A separate `count` query is often
the cheaper shape for a hot read.

Reference: <https://nstfkc.github.io/gemi/orm.md>
