---
title: The defineDictionary Literal Must Be Inline
impact: MEDIUM
impactDescription: passes tests, fails the build
tags: i18n, build, vite, gotcha
---

## The defineDictionary Literal Must Be Inline

New i18n work uses `defineDictionary` (gemi 0.54): a `<Component>.i18n.ts` beside the
component, read with `useDictionary(theDict)`. gemi's Vite plugin **rewrites the call
at build time** and needs the object to be statically analyzable.

A helper call, variable, spread or template literal **fails the BUILD** — while
still resolving fine under test. That asymmetry is the trap: the refactor looks
green locally and breaks CI at the build step.

**Incorrect (factored behind a helper — resolves in tests, fails the build):**

```ts
const copy = (en: string, tr: string) => ({ "en-US": en, "tr-TR": tr });

export const dict = defineDictionary({
  title: copy("Products", "Ürünler"),
  ...sharedKeys,
});
```

**Correct (inline literal, `en-US` first in every key):**

```ts
export const dict = defineDictionary({
  title: {
    "en-US": "Products",
    "tr-TR": "Ürünler",
    "de-DE": "Produkte",
    // …
  },
});
```

Rules that come with it:

- **Write `en-US` first in every key.** The first locale is the source language and
  the fallback when another locale is missing a key; if keys disagree on ordering,
  the build stops.
- **No name string, no `app/i18n/index.ts` entry, no prefetch map, no `gemi.d.ts`
  declaration.** Keys and `{{param}}` types are inferred from the literal.
- **Name a key after the copy it holds**, not its call site — `new`, not `button`.
  A key named for where it is used drifts the moment the copy moves.
- Untransformed it holds every locale and resolves **synchronously**, so a component
  test asserts the real copy with nothing seeded. Assert `en-US` only.
- **A missing translation degrades silently** (it falls back to the source locale)
  rather than failing — completeness across locales wants one i18n-level check, not
  an assertion in every component test.

The legacy `Dictionary.create` system is still the bulk of the app and both coexist.
Migrate per component when you touch it; there is no sweep planned.
