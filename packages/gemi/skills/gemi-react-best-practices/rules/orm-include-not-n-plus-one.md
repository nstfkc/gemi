---
title: One include Tree Beats a Loop of Queries
impact: HIGH
impactDescription: N+1 round trips to 1
tags: orm, n-plus-one, include, relations
---

## One include Tree Beats a Loop of Queries

On Postgres, gemi's default **lateral** strategy folds an entire `include` /
nested-`select` tree into the root statement using `LATERAL` joins and `json_agg` —
one round trip for the whole tree. A loop that queries per row gets none of that.

**Incorrect (1 + N round trips):**

```ts
const products = await Product.findMany({ where: { organizationId } });
const withMedia = await Promise.all(
  products.map(async (product) => ({
    ...product,
    media: await Media.findMany({ where: { productId: product.id } }),
  })),
);
```

**Correct (one statement):**

```ts
const products = await Product.findMany({
  where: { organizationId },
  include: { media: true },
});
```

**Know when the lateral strategy declines**, because those nodes fall back to
batched (one query per include node) and a deep tree can quietly become several
round trips. It declines for: implicit many-to-many relations, self-relations, nodes
with `_count`, nodes ordered by a relation, and **any descendant of a declined
node**. If a read is hot and its tree contains one of these, consider restructuring
the tree rather than accepting the fallback.

**`take` inside a to-many is per-parent, not total** — `take: 10` on an included
relation means ten per parent. That requires the lateral strategy; batched mode
refuses it.

**Index the foreign keys.** Relation filters, counts and orderings compile to
correlated subqueries that run once per parent row; without an index on the child's
FK each run scans the table.

Override per call when you need the other strategy:

```ts
await User.findMany({ include: { accounts: true } }, { strategy: "batched" });
```

Reference: <https://nstfkc.github.io/gemi/orm.md>
