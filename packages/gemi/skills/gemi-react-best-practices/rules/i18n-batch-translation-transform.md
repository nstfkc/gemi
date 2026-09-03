---
title: Batch TranslationService.transform, Do Not Call It Per Item
impact: MEDIUM
impactDescription: N calls to 1
tags: i18n, translation, batching, controllers
---

## Batch TranslationService.transform, Do Not Call It Per Item

`TranslationService.transform` accepts an array. Calling it inside a `map` over a
collection turns one batched lookup into one per row — the same N+1 shape as
`orm-include-not-n-plus-one`, on the translation layer instead of the database.

**Incorrect (one call per item):**

```ts
const products = await Product.findMany({ where: { organizationId } });
const translated = await Promise.all(
  products.map((product) => TranslationService.transform(product, locale)),
);
```

**Correct (one call for the collection):**

```ts
const products = await Product.findMany({ where: { organizationId } });
const translated = await TranslationService.transform(products, locale);
```

**Batch across values too**, not just within a collection. `transform` walks a whole
structure, so a handler that translates several things passes **one composite
object** and destructures the result — not one call per value:

```ts
// Incorrect — two round trips through the translation layer
const store = await TranslationService.transform(rawStore, locale);
const catalog = await TranslationService.transform(rawCatalog, locale);

// Correct — one call covers the nested arrays too
const { name, description, products } = await TranslationService.transform(
  {
    name: rawStore.name,
    description: rawStore.description,
    products: rawCatalog.products,
  },
  locale,
);
```

Translate on the server, in the controller, where the locale is available as
`req.locale()`. Shipping untranslated rows to the client and translating there costs
a round-trip and puts the dictionary in the bundle.
