---
title: Match the Suite You Are In
impact: MEDIUM
impactDescription: a test the runner never selects is a test that does not exist
tags: testing, runner, conventions
---

## Match the Suite You Are In

Before adding a test, read the neighbours and the runner config. Copy the runner, the
import source, and the file-naming convention already in use in that directory. A
test written for the wrong runner does not fail loudly — the runner simply never
selects the file, and it sits green forever without executing.

**This is the whole rule for the common case.** Everything below is the gemi-specific
part: the two things that trip up a component test in a gemi app regardless of which
runner you picked.

**A component test needs a DOM.** gemi renders on the server, so a suite configured
as a plain Node project has no `window`. Mounting a view there fails on the first
DOM call, not with a useful message. Either point that suite at a DOM environment
(`jsdom`, `happy-dom`) or put component tests in the half of the suite that has one.

**A test of the server dictionary readers must drop `window` first.**
`Dictionary.render` and `Dictionary.reference` throw in a browser-shaped environment,
so a DOM-providing preload breaks them for the whole run. Reach for the server
globals helper at module scope — a dictionary is often read while the test module
evaluates, before any `beforeEach` has run.

**Incorrect (a component test in the Node-only half of the suite):**

```ts
// runs, finds no document, fails on render
import { render } from "@testing-library/react";
import { describe, it } from "vitest";
```

**Correct (the same test where a DOM exists):**

```ts
import { render } from "@testing-library/react";
import { describe, it } from "vitest"; // or "bun:test" — whichever this suite uses

// vitest.config.ts: environment: "jsdom"
```

Two notes if your repo runs more than one runner:

- **The file name is usually the selection mechanism.** `bun test` has no
  include-pattern config, so a repo running both typically selects the bun half by a
  path fragment (`<name>.bun.test.ts`) and excludes that same fragment from the other
  runner's config. Renaming a file is what moves it between halves.
- **`vi.hoisted` / `vi.mock` do not port.** They rely on Vitest's AST hoisting, which
  `bun:test` has no equivalent for. A file using only `describe`/`it`/`expect` is an
  import swap; a file using those needs rewriting.

See also `testing-page-seeds-real-inputs` for how to mount a gemi view under test.
