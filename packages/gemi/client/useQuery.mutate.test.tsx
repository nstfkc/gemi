/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { QueryManagerProvider } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { useQuery } from "./useQuery";

/**
 * `onClick={mutate}` hands React's event to `mutate` as its argument. Taken as
 * the new data, it is not a plain object, so the shape check threw from inside
 * the click handler (issue #623). Where the route is untyped the data is `any`
 * and nothing caught it at compile time. An event carries no data, so it now
 * means what a bare `mutate()` means: refetch.
 */

function createFetch() {
  const pending: Array<(body: unknown) => void> = [];
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        pending.push((body) =>
          resolve({ ok: true, status: 200, json: async () => body } as Response),
        );
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    async resolve(body: unknown) {
      const settle = pending.shift();
      if (!settle) throw new Error("No pending fetch to resolve");
      await act(async () => settle(body));
    },
    /** Resolve the pending request at `index` (0 is the oldest). */
    async resolveAt(index: number, body: unknown) {
      const [settle] = pending.splice(index, 1);
      if (!settle) throw new Error(`No pending fetch at index ${index}`);
      await act(async () => settle(body));
    },
  };
}

function Providers(props: PropsWithChildren) {
  return (
    <QueryManagerProvider>
      <RouteStateProvider state={{} as RouteState & PageData}>
        {props.children}
      </RouteStateProvider>
    </QueryManagerProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useQuery's mutate as an event handler", () => {
  test("a click refetches instead of throwing", async () => {
    const net = createFetch();
    const errors: unknown[] = [];
    function View() {
      const { data, mutate } = useQuery("/todos" as any, {}, { suspense: false });
      return (
        <button
          onClick={(event) => {
            try {
              mutate(event as any);
            } catch (error) {
              errors.push(error);
            }
          }}
        >
          {data ? data.title : "loading"}
        </button>
      );
    }

    render(<View />, { wrapper: Providers });
    await net.resolve({ title: "first" });
    expect(screen.getByRole("button").textContent).toBe("first");
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button"));
    expect(errors).toEqual([]);
    expect(net.fetchMock).toHaveBeenCalledTimes(2);

    await net.resolve({ title: "second" });
    expect(screen.getByRole("button").textContent).toBe("second");
  });

  test("a native event is ignored the same way", async () => {
    const net = createFetch();
    let mutateRef!: (value?: any) => void;
    function View() {
      const { data, mutate } = useQuery("/todos" as any, {}, { suspense: false });
      mutateRef = mutate;
      return <p>{data ? data.title : "loading"}</p>;
    }

    render(<View />, { wrapper: Providers });
    await net.resolve({ title: "first" });

    expect(() => act(() => mutateRef(new Event("click")))).not.toThrow();
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("first")).toBeTruthy();
  });

  test("a plain object with event-like keys is still data", async () => {
    const net = createFetch();
    let mutateRef!: (value?: any) => void;
    function View() {
      const { data, mutate } = useQuery("/todos" as any, {}, { suspense: false });
      mutateRef = mutate;
      return <p>{data ? data.title : "loading"}</p>;
    }

    render(<View />, { wrapper: Providers });
    await net.resolve({ title: "first" });

    act(() =>
      mutateRef({ title: "optimistic", nativeEvent: null, preventDefault: null }),
    );
    expect(screen.getByText("optimistic")).toBeTruthy();
  });
});

describe("useQuery's mutate with overlapping refetches (#677)", () => {
  test("an older response landing last does not replace what is on screen", async () => {
    const net = createFetch();
    let mutateRef!: (value?: any) => void;
    function View() {
      const { data, mutate } = useQuery(
        "/pages/1" as any,
        {},
        { suspense: false },
      );
      mutateRef = mutate;
      return <p>{data ? data.images.join(",") || "empty" : "loading"}</p>;
    }

    render(<View />, { wrapper: Providers });
    await net.resolve({ images: [] });
    expect(screen.getByText("empty")).toBeTruthy();

    act(() => mutateRef()); // after image A is saved
    act(() => mutateRef()); // after image B is saved

    await net.resolveAt(1, { images: ["a", "b"] });
    expect(screen.getByText("a,b")).toBeTruthy();
    await net.resolveAt(0, { images: ["a"] });
    expect(screen.getByText("a,b")).toBeTruthy();
  });
});
