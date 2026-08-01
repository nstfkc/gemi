/** @vitest-environment jsdom */
import { afterEach, describe, expect, test } from "vitest";
import { Suspense, act, startTransition, use, useState } from "react";
import { cleanup, render } from "@testing-library/react";

// Auto-cleanup needs vitest globals, which this repo doesn't enable.
afterEach(cleanup);

/**
 * Pins the React semantics the router's boundary placement is built on
 * (`Route` wraps every segment in its own `Suspense`). Measured on React
 * 19.2.3 — and notably *not* what a reading of the docs' "the nested boundary
 * is new, so the transition doesn't wait for it" would predict:
 *
 * 1. When everything the transition replaces is suspended — even inside a
 *    boundary the transition itself mounted — React stays on the previous
 *    screen and waits. No fallback is shown.
 * 2. When the transition also has new content that can commit (a shell, a new
 *    layout's chrome), it commits, and the suspended sibling boundary shows
 *    its fallback.
 *
 * For navigation this means: a leaf-to-leaf swap under a persistent layout
 * keeps the previous page on screen (surfaced via `Link[data-pending]`),
 * while entering a freshly mounted layout commits the layout and shows the
 * suspended leaf's `Loading` export. If a React upgrade changes either
 * behavior, the router's boundary placement needs revisiting — that is why
 * this is a permanent test and not a scratch experiment.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function Content(props: { promise: Promise<string>; label: string }) {
  const value = use(props.promise);
  return <div>{`${props.label}:${value}`}</div>;
}

describe("Suspense inside a transition", () => {
  test("an already revealed boundary keeps the old content while it waits", async () => {
    const gate = deferred<string>();
    let setPage!: (page: "a" | "b") => void;

    function App() {
      const [page, _setPage] = useState<"a" | "b">("a");
      setPage = _setPage;
      return (
        <Suspense fallback={<div>fallback</div>}>
          {page === "a" ? (
            <div>page-a</div>
          ) : (
            <Content promise={gate.promise} label="page-b" />
          )}
        </Suspense>
      );
    }

    const screen = render(<App />);
    expect(screen.queryByText("page-a")).not.toBeNull();

    await act(async () => {
      startTransition(() => setPage("b"));
    });

    // The boundary was already revealed: the transition waits, the old page
    // stays, no fallback.
    expect(screen.queryByText("page-a")).not.toBeNull();
    expect(screen.queryByText("fallback")).toBeNull();

    await act(async () => {
      gate.resolve("ready");
    });

    expect(screen.queryByText("page-b:ready")).not.toBeNull();
    expect(screen.queryByText("page-a")).toBeNull();
  });

  test("a leaf swap under a persistent layout keeps the previous page (router shape)", async () => {
    const gate = deferred<string>();
    let setPage!: (page: "a" | "b") => void;

    function App() {
      const [page, _setPage] = useState<"a" | "b">("a");
      setPage = _setPage;
      return (
        <Suspense fallback={<div>outer-fallback</div>}>
          <div>layout</div>
          {page === "a" ? (
            <Suspense fallback={<div>fallback-a</div>}>
              <div>page-a</div>
            </Suspense>
          ) : (
            <Suspense fallback={<div>fallback-b</div>}>
              <Content promise={gate.promise} label="page-b" />
            </Suspense>
          )}
        </Suspense>
      );
    }

    const screen = render(<App />);
    expect(screen.queryByText("page-a")).not.toBeNull();

    await act(async () => {
      startTransition(() => setPage("b"));
    });

    // The new leaf boundary suspends and nothing else changed — React stays
    // on the previous screen rather than committing the fallback.
    expect(screen.queryByText("page-a")).not.toBeNull();
    expect(screen.queryByText("fallback-b")).toBeNull();

    await act(async () => {
      gate.resolve("ready");
    });

    expect(screen.queryByText("page-b:ready")).not.toBeNull();
    expect(screen.queryByText("page-a")).toBeNull();
  });

  test("a boundary that is the entire new content also waits, even though it is new", async () => {
    const gate = deferred<string>();
    let setPage!: (page: "a" | "b") => void;

    function App() {
      const [page, _setPage] = useState<"a" | "b">("a");
      setPage = _setPage;
      return page === "a" ? (
        <Suspense fallback={<div>fallback-a</div>}>
          <div>page-a</div>
        </Suspense>
      ) : (
        <Suspense fallback={<div>fallback-b</div>}>
          <Content promise={gate.promise} label="page-b" />
        </Suspense>
      );
    }

    const screen = render(<App />);
    expect(screen.queryByText("page-a")).not.toBeNull();

    await act(async () => {
      startTransition(() => setPage("b"));
    });

    expect(screen.queryByText("page-a")).not.toBeNull();
    expect(screen.queryByText("fallback-b")).toBeNull();

    await act(async () => {
      gate.resolve("ready");
    });

    expect(screen.queryByText("page-b:ready")).not.toBeNull();
  });

  test("new shell content commits and reveals the suspended sibling's fallback", async () => {
    const gate = deferred<string>();
    let setPage!: (page: "a" | "b") => void;

    function App() {
      const [page, _setPage] = useState<"a" | "b">("a");
      setPage = _setPage;
      return page === "a" ? (
        <div>page-a</div>
      ) : (
        <div>
          <div>b-shell</div>
          <Suspense fallback={<div>fallback-b</div>}>
            <Content promise={gate.promise} label="page-b" />
          </Suspense>
        </div>
      );
    }

    const screen = render(<App />);

    await act(async () => {
      startTransition(() => setPage("b"));
    });

    // The shell can commit, so the transition does not hold the old screen —
    // the new chrome appears with the suspended part's fallback.
    expect(screen.queryByText("page-a")).toBeNull();
    expect(screen.queryByText("b-shell")).not.toBeNull();
    expect(screen.queryByText("fallback-b")).not.toBeNull();

    await act(async () => {
      gate.resolve("ready");
    });

    expect(screen.queryByText("page-b:ready")).not.toBeNull();
  });
});
