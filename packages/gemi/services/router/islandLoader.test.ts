// @vitest-environment jsdom
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ISLAND_LOADER_SOURCE } from "./staticDocument";

/**
 * The island loader as the browser runs it: the constant source against a
 * document with markers and a table, importing real modules.
 */

const fixtures = join(import.meta.dirname, "__fixtures__/islands");
// Paths rather than URLs: the test's module runner imports by path.
const mountSrc = join(fixtures, "mount.mjs");
const brokenSrc = join(fixtures, "broken.mjs");

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function page(markup: string, table: Record<string, { src: string; load: string }>) {
  document.body.innerHTML =
    markup + `<script type="application/json" id="gemi-islands">${JSON.stringify(table)}</script>`;
}

/**
 * Runs the loader. Code built with `new Function` has no module context to
 * resolve a bare `import()` against, so the one dynamic import is handed in;
 * everything else is the source exactly as shipped.
 */
function runLoader() {
  expect(ISLAND_LOADER_SOURCE.match(/import\(/g)).toHaveLength(1);
  new Function("__import", ISLAND_LOADER_SOURCE.replace("import(", "__import("))(
    (specifier: string) => import(/* @vite-ignore */ specifier),
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const markers = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(`gemi-island[name="${name}"]`));

describe("the island loader", () => {
  test("mounts every marker of an eager island once, with its props", async () => {
    page(
      `<gemi-island name="menu" data-props='{"open":false}'><button>a</button></gemi-island>` +
        `<gemi-island name="menu"><button>b</button></gemi-island>`,
      { menu: { src: mountSrc, load: "eager" } },
    );
    runLoader();
    await settle();

    const [first, second] = markers("menu");
    expect(first.dataset.mounts).toBe("1");
    expect(JSON.parse(first.dataset.received!)).toEqual({ open: false });
    expect(second.dataset.mounts).toBe("1");
    // No `data-props`: the island did not ask for them.
    expect(JSON.parse(second.dataset.received!)).toBe("undefined");
  });

  test("leaves markers alone that the table does not name", async () => {
    page(`<gemi-island name="unknown"><p>x</p></gemi-island>`, {});
    runLoader();
    await settle();

    expect(markers("unknown")[0].dataset.mounts).toBeUndefined();
  });

  test("waits for idle time on an idle island", async () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (fn: () => void) => callbacks.push(fn));
    page(`<gemi-island name="later"><p>x</p></gemi-island>`, {
      later: { src: mountSrc, load: "idle" },
    });
    runLoader();
    await settle();
    expect(markers("later")[0].dataset.mounts).toBeUndefined();

    callbacks.forEach((fn) => fn());
    await settle();
    expect(markers("later")[0].dataset.mounts).toBe("1");
  });

  test("waits for a visible island's content to scroll into view", async () => {
    const observers: { cb: (entries: { isIntersecting: boolean }[]) => void; targets: Element[] }[] =
      [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        targets: Element[] = [];
        constructor(public cb: (entries: { isIntersecting: boolean }[]) => void) {
          observers.push(this);
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        disconnect() {}
      },
    );
    page(`<gemi-island name="map"><canvas></canvas></gemi-island>`, {
      map: { src: mountSrc, load: "visible" },
    });
    runLoader();
    await settle();

    // The marker is `display: contents` and has no box: its children are
    // what gets observed.
    expect(observers[0].targets[0].tagName).toBe("CANVAS");
    expect(markers("map")[0].dataset.mounts).toBeUndefined();

    observers[0].cb([{ isIntersecting: true }]);
    await settle();
    expect(markers("map")[0].dataset.mounts).toBe("1");
  });

  test("logs a module that fails and keeps the server-rendered markup", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    page(`<gemi-island name="bad"><a href="/x">x</a></gemi-island>`, {
      bad: { src: brokenSrc, load: "eager" },
    });
    runLoader();
    await settle();

    expect(error).toHaveBeenCalled();
    expect(markers("bad")[0].innerHTML).toBe('<a href="/x">x</a>');
  });
});
