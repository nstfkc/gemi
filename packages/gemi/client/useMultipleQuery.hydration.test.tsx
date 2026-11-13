/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";

import { QueryManagerProvider } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { useMultipleQuery } from "./useMultipleQuery";
import { useQuery } from "./useQuery";

/**
 * #1253: a streaming server render starts a `suspense: false` key in the
 * request's store but renders it as loading, since its answer may still be on
 * the wire. The answer reaches the client as a `__GEMI_STREAM__` payload, often
 * before the client entry hydrates. Hydration must still render the key as the
 * server did (no mismatch), then show the streamed answer without a fetch.
 */

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  delete (window as any).__GEMI_STREAM__;
  vi.unstubAllGlobals();
});

function hydrate(ui: React.ReactNode, serverHtml: string) {
  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.appendChild(container);
  const recoverable = vi.fn();
  act(() => {
    root = hydrateRoot(
      container,
      <QueryManagerProvider>
        <RouteStateProvider state={{} as RouteState & PageData}>
          {ui}
        </RouteStateProvider>
      </QueryManagerProvider>,
      { onRecoverableError: recoverable },
    );
  });
  return { container, recoverable };
}

describe("hydrating a suspense: false key whose answer was streamed", () => {
  test("useMultipleQuery hydrates loading, then shows the streamed answer without fetching", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    (window as any).__GEMI_STREAM__ = [["/a", "", { v: 1 }]];
    function View() {
      const { data, loadingByKey } = useMultipleQuery(
        { a: ["/a" as any] },
        { suspense: false },
      );
      return <p>{`${(data.a as any)?.v}:${loadingByKey.a}`}</p>;
    }
    const { container, recoverable } = hydrate(
      <View />,
      "<p>undefined:true</p>",
    );
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.textContent).toBe("1:false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("useQuery hydrates loading, then shows the streamed answer without fetching", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    (window as any).__GEMI_STREAM__ = [["/a", "", { v: 1 }]];
    function View() {
      const { data, loading } = useQuery("/a" as any, undefined, {
        suspense: false,
      });
      return <p>{`${(data as any)?.v}:${loading}`}</p>;
    }
    const { container, recoverable } = hydrate(
      <View />,
      "<p>undefined:true</p>",
    );
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.textContent).toBe("1:false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a suspending key still hydrates with the streamed answer", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    (window as any).__GEMI_STREAM__ = [["/a", "", { v: 1 }]];
    function View() {
      const { data } = useMultipleQuery({ a: ["/a" as any] });
      return <p>{`${(data.a as any).v}`}</p>;
    }
    const { container, recoverable } = hydrate(<View />, "<p>1</p>");
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.textContent).toBe("1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
