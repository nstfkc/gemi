# Browser Probes

When your server reads a page in a headless browser (puppeteer, playwright, a hosted Chrome), it runs code in the page with `page.evaluate`. That takes one self-contained function: its source is sent to the browser as text, so it can use nothing from outside itself. No imports, no helpers at the top of the file, no types or constants shared with the server. Code that reads a page for real (its layout, its colours, its content) then grows into one function of hundreds of lines.

A **probe** is that code written as a normal module. gemi bundles it, with everything it imports, into one self-contained script for the browser, and `probe(...).run(page, ...args)` runs it in the page and returns its result, typed.

```typescript
// app/utils/layout.probe.ts — runs in the page
import { boxOf, type Box } from "./geometry";

export default function readLayout(sections: string[]): { name: string; box: Box }[] {
  return sections.flatMap((name) => {
    const element = document.querySelector(`[data-section="${name}"]`);
    return element ? [{ name, box: boxOf(element.getBoundingClientRect()) }] : [];
  });
}
```

```typescript
// app/services/LayoutChecks.ts — runs on the server
import { probe } from "gemi/probe";

const readLayout = probe<typeof import("@/app/utils/layout.probe")>("utils/layout");

// `page` is a puppeteer or playwright Page.
const layout = await readLayout.run(page, ["hero", "pricing"]);
//    ^? { name: string; box: Box }[]
```

## Writing a probe

- A probe is a file under `app/` named `*.probe.ts` (or `*.probe.js`). Its **default export** is the function that runs in the page. It may be `async`; `run` resolves to what it resolves to.
- It may import anything that bundles for the browser: your own helpers, types, constants shared with the server, packages. Only what it uses is bundled.
- It runs in the page, so it uses the page's `window` and `document`, not the server's. Nothing it imports runs on the server when you call `run`.
- Its **arguments** are sent as JSON, so they must be JSON values (strings, numbers, booleans, `null`, arrays and plain objects). Its **result** comes back the way your driver returns `evaluate`'s result: for puppeteer and playwright, JSON-like values (a DOM node or a function does not survive).

A probe is **named by its path under `app/`** without the suffix: `app/utils/layout.probe.ts` is `"utils/layout"`, `app/probes/content.probe.ts` is `"probes/content"`.

## Running one

`probe<M>(name)` from `gemi/probe` returns a handle. `M` is the probe's module (`typeof import("@/app/…")`) or its function's type; the handle's arguments and result are typed from the default export.

| Method | What it does |
| --- | --- |
| `run(page, ...args)` | Runs the probe in `page` and resolves to its (awaited) result. `page` is anything with `evaluate(expression: string): Promise<unknown>`, which puppeteer's and playwright's `Page` both are. |
| `expression(...args)` | The JavaScript expression `run` evaluates, for a driver that takes a script string. It evaluates to the probe's result (a promise, for an async probe). |
| `source()` | The bundled script itself. |

gemi does not open a browser: your app keeps its own (a local Chrome in development, a hosted one in production) and hands its page to `run`.

```typescript
// A driver that takes the source of a function to call, rather than a page:
const expression = await readLayout.expression(["hero"]);
await provider.capture(url, { script: `() => ${expression}` });
```

The expression is `(() => { …bundle…; return probe(...args); })()`, so it declares nothing in the page's scope and can run any number of times in one page.

## Bundling and caching

Each probe is bundled with `Bun.build` (target browser, minified, one IIFE), the way a static view's [document script](./static-views-and-islands.md) is.

- **`gemi build`** bundles every `app/**/*.probe.{ts,js}` into `dist/server/probes.json`, and `gemi start` reads it, so production never runs the bundler. A probe the manifest lacks is bundled from source once. A probe that does not bundle fails the build.
- **In development and tests** a probe is bundled on its first `run` and kept until the probe or any file it imports changes (compared by modification time), so an edit shows on the next run and an unchanged probe is not bundled again.

A probe that does not bundle throws on `run` with the bundler's messages; a name with no file throws naming the file it looked for.

## Testing a probe

`run` only needs an object with `evaluate`, so a test can hand it a fake page, or run the expression in jsdom:

```typescript
import { JSDOM } from "jsdom";
import { probe } from "gemi/probe";

const dom = new JSDOM(`<section data-section="hero"></section>`, { runScripts: "outside-only" });
const page = { evaluate: async (expression: string) => dom.window.eval(expression) };

const layout = await probe<typeof import("@/app/utils/layout.probe")>("utils/layout").run(page, ["hero"]);
```

jsdom does no layout (every box is zero), so a probe that measures belongs in a test with a real headless browser.
