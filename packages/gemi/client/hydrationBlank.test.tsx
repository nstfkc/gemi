/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Suspense, act, lazy, startTransition, useSyncExternalStore } from "react";
import { renderToString } from "react-dom/server";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";

/**
 * Why a cold load used to render its content, drop it, and render it again.
 *
 * The server renders every route segment through a real component, so the
 * shell ships complete `<Suspense>` boundaries. The browser renders the same
 * segments through `lazy()`, so on the first client render each of them
 * suspends. React tolerates that on its own — a boundary that merely suspends
 * during hydration keeps its server HTML on screen — but it does not tolerate
 * an update arriving while the boundary is in that state: the boundary is
 * client-rendered from scratch, which for a view with no `Loading` export
 * means an empty fallback where the content was.
 *
 * `ComponentContext` produces exactly such an update. `loadViewModule`
 * announces the module to `Route`'s `useSyncExternalStore` on the view's first
 * registration, which is one dictionary await *before* the `lazy()` promise it
 * is resolving settles.
 *
 * The registry below is the real shape, because the shape is the point: a
 * fresh promise per `lazy` ctor call (`loadViewModule` does not memoize) and a
 * notification guarded on first registration. That guard is what
 * `initialViewModulesReady` exploits — see the last case — and a test built on
 * one pre-resolved promise reused across renders would pass without pinning
 * any of it.
 *
 * Measured on React 19.2.3.
 */

let container: HTMLDivElement;
let root: Root | null = null;

/** `viewModules` + `viewModuleListeners`, reduced to one view. */
let registered: boolean;
let listeners: Set<() => void>;
/** Settles the pending `loadViewModule` call, standing in for the chunk landing. */
let landChunk: (() => void) | null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => registered;

function Content() {
  return <p>content</p>;
}

/**
 * `loadViewModule`, minus the parts that don't bear on this: a fresh promise
 * every call, listeners notified only on first registration, and the notify
 * sequenced ahead of the promise it hands back (the dictionary await).
 */
function loadViewModule(): Promise<{ default: typeof Content }> {
  return new Promise((resolve) => {
    landChunk = () => {
      const isNew = !registered;
      registered = true;
      if (isNew) for (const listener of listeners) listener();
      resolve({ default: Content });
    };
  });
}

/** A route segment: subscribed to the module registry, wrapped in its own boundary. */
function Route(props: { children: React.ReactNode }) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return <Suspense fallback={null}>{props.children}</Suspense>;
}

/** Hydrates the server's markup for `<Route><Content /></Route>`. */
async function hydrateOverServerMarkup(children: React.ReactNode) {
  container.innerHTML = renderToString(
    <Route>
      <Content />
    </Route>,
  );
  expect(container.textContent).toBe("content");

  await act(async () => {
    root = hydrateRoot(container, <Route>{children}</Route>);
  });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  registered = false;
  listeners = new Set();
  landChunk = null;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("a route segment hydrating over server markup", () => {
  test("keeps the server content while its lazy is merely pending", async () => {
    const Lazy = lazy(loadViewModule);

    await hydrateOverServerMarkup(<Lazy />);

    expect(container.textContent).toBe("content");
  });

  test("drops it when the chunk's first registration notifies mid-hydration", async () => {
    const Lazy = lazy(loadViewModule);

    await hydrateOverServerMarkup(<Lazy />);

    // The notify and the promise it precedes, in `loadViewModule`'s order. The
    // await between them is the dictionary warm-up; here it is one act tick.
    await act(async () => {
      const isNew = !registered;
      registered = true;
      if (isNew) for (const listener of listeners) listener();
    });

    expect(container.textContent).toBe("");

    await act(async () => landChunk!());

    // The content comes back — a round trip the user sees as a flash, lasting
    // as long as the chunk's evaluation and dictionary warm-up take.
    expect(container.textContent).toBe("content");
  });

  // Forecloses the obvious fix. The advice React prints for a boundary that
  // "received an update before it finished hydrating" is to wrap the update in
  // a transition, but that applies to a boundary the server left *pending*.
  // This one was served complete, so the transition commits the fallback just
  // the same, and only the preload in the last case actually helps.
  test("is dropped even when that notification is a transition", async () => {
    const Lazy = lazy(loadViewModule);

    await hydrateOverServerMarkup(<Lazy />);

    await act(async () => {
      registered = true;
      startTransition(() => {
        for (const listener of listeners) listener();
      });
    });

    expect(container.textContent).toBe("");
  });

  test("and not because a settled promise would render synchronously", async () => {
    // The mechanism the fix does NOT rely on. Even handed a promise that
    // settled before the render, `lazy` attaches `.then` and re-reads a status
    // its callback sets a microtask later, so the first render still suspends.
    //
    // A plain client render, not a hydration: with no server markup to keep,
    // the fallback is visible and the question — does `lazy` resolve within
    // the render — gets a straight answer.
    const settled = Promise.resolve({ default: Content });
    await settled;
    const Lazy = lazy(() => settled);

    const solo = document.createElement("div");
    document.body.appendChild(solo);
    const soloRoot = createRoot(solo);
    act(() => {
      soloRoot.render(
        <Suspense fallback={<i>fallback</i>}>
          <Lazy />
        </Suspense>,
      );
    });

    expect(solo.textContent).toBe("fallback");

    await act(async () => {
      await settled;
    });
    expect(solo.textContent).toBe("content");

    act(() => soloRoot.unmount());
    solo.remove();
  });

  test("survives when the module is registered before hydration starts", async () => {
    // What `initialViewModulesReady` buys, and the only thing it buys: the
    // view is already in the registry, so the call `lazy` makes during
    // hydration finds `isNew` false and notifies nobody. The boundary still
    // suspends — it just suspends with no update reaching it.
    const preload = loadViewModule();
    landChunk!();
    await preload;
    expect(registered).toBe(true);

    const notified: string[] = [];
    listeners.add(() => notified.push("notified"));

    const Lazy = lazy(loadViewModule);
    await hydrateOverServerMarkup(<Lazy />);
    await act(async () => landChunk!());

    expect(notified).toEqual([]);
    expect(container.textContent).toBe("content");
  });
});
