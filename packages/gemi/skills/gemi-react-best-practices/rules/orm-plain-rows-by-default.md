---
title: Plain Rows Are the Default — Opt Into Tracking Deliberately
impact: MEDIUM
impactDescription: ~100% read overhead when tracking is on
tags: orm, rows, tracking, performance
---

## Plain Rows Are the Default — Opt Into Tracking Deliberately

Queries return plain objects. No proxying, no hydration, no identity map — so a row
can be spread, serialized, or handed to a view freely, and `select` narrows the
**type** as well as the columns. This costs nothing, which is why it is the default.

Two opt-ins exist above it, and both have a price:

- **`{ track: true }`** enables `Model.save(row)` differential updates — only changed
  columns are written, and an unchanged row produces no SQL at all. It costs roughly
  **100% overhead on a 1,000-row read** (WeakMap insertion plus snapshot cloning), so
  it does not belong on a list read.
- **`Model.wrap(row)`** adds model methods and getters. It **requires a complete
  row** — a partial `select` is a compile error — and tracks automatically.

**Incorrect (tracking a list read that is only being serialized):**

```ts
const products = await Product.findMany(
  { where: { organizationId } },
  { track: true },        // pure overhead; nothing here is saved
);
return { products };
```

**Correct (plain for reads; track the single row you intend to mutate):**

```ts
const products = await Product.findMany({
  where: { organizationId },
  select: { publicId: true, name: true },
});

const product = await Product.findUnique({ where: { id } }, { track: true });
product.name = nextName;
await Product.save(product);   // writes only `name`
```

**Provenance is keyed on object identity via a WeakMap**, so spreading, cloning or
serializing loses it — `Model.save({ ...product })` throws. It also cannot assign to
a column the query did not fetch, and a tracked row remembers which connection
produced it, so `save()` returns to the right pool.

**There is no identity map and no lazy loading.** Two reads of the same row return
two distinct objects that do not synchronize. Coordinate saves inside a
`Model.transaction`, sequentially (`orm-transaction-sequential`).

Reference: <https://nstfkc.github.io/gemi/orm-rows-and-entities.md>
