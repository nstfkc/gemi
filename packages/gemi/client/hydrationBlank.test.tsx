/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Suspense, act, lazy, startTransition, useSyncExternalStore } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";

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
 * announces the module to `Route`'s `useSyncExternalStore` as soon as the
 * chunk lands, which is one dictionary await *before* the `lazy()` promise it
 * is resolving settles. The cases below pin the React behavior that rules out
 * every fix except the one `initialViewModulesReady` implements, so a React
 * upgrade that changes any of them shows up here rather than as a flash on a
 * production landing page.
 *
 * Measured on React 19.2.3.
 */

let container: HTMLDivElement;
let root: Root | null = null;

// The registry from `ComponentContext`, reduced to the part that matters: a
// store `Route` subscribes to, notified when a view module lands.
let listeners: Set<() => void>;
let moduleLanded: boolean;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => moduleLanded;

function Content() {
  return <p>content</p>;
}

/** A route segment: subscribed to the module registry, wrapped in its own boundary. */
function Route(props: { children: React.ReactNode }) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return <Suspense fallback={null}>{props.children}</Suspense>;
}

function deferredLazy() {
  let resolve!: (mod: { default: typeof Content }) => void;
  const promise = new Promise<{ default: typeof Content }>((r) => {
    resolve = r;
  });
  return { Lazy: lazy(() => promise), promise, resolve };
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
  listeners = new Set();
  moduleLanded = false;
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
    const { Lazy } = deferredLazy();

    await hydrateOverServerMarkup(<Lazy />);

    expect(container.textContent).toBe("content");
  });

  test("drops it when a sync update lands before the lazy resolves", async () => {
    const { Lazy, promise, resolve } = deferredLazy();

    await hydrateOverServerMarkup(<Lazy />);

    // Where `loadViewModule` notifies: the chunk has landed, the lazy it
    // feeds has not settled yet.
    await act(async () => {
      moduleLanded = true;
      for (const listener of listeners) listener();
    });

    expect(container.textContent).toBe("");

    await act(async () => {
      resolve({ default: Content });
      await promise;
    });

    // The content comes back — a round trip the user sees as a flash, lasting
    // as long as the chunk's evaluation and dictionary warm-up take.
    expect(container.textContent).toBe("content");
  });

  // Forecloses the obvious fix. The advice React prints for a boundary that
  // "received an update before it finished hydrating" is to wrap the update in
  // a transition, but that applies to a boundary the server left *pending*.
  // This one was served complete, so the transition commits the fallback just
  // the same, and only the preload in the next case actually helps.
  test("is dropped even when that update is a transition", async () => {
    const { Lazy } = deferredLazy();

    await hydrateOverServerMarkup(<Lazy />);

    await act(async () => {
      moduleLanded = true;
      startTransition(() => {
        for (const listener of listeners) listener();
      });
    });

    expect(container.textContent).toBe("");
  });

  test("is immune to either once the lazy is resolved before hydration", async () => {
    const { Lazy, promise, resolve } = deferredLazy();

    // What `initialViewModulesReady` buys: the module is in hand before
    // `hydrateRoot` runs, so `lazy()` returns the component synchronously and
    // no boundary is ever left half-hydrated for an update to blank.
    resolve({ default: Content });
    await promise;

    await hydrateOverServerMarkup(<Lazy />);

    await act(async () => {
      moduleLanded = true;
      for (const listener of listeners) listener();
    });

    expect(container.textContent).toBe("content");
  });
});
