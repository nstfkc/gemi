/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { loadLazy } from "./lazyModule";
import { mutationExtras } from "./mutationModules";
import { QueryManagerProvider } from "./QueryManagerContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { useMutation } from "./useMutation";
import { useQuery } from "./useQuery";
import { useSetQueryData } from "./useSetQueryData";

/**
 * Issue #915: the mutation hooks' `error.list()` / `error.field()` and the
 * cache writes behind `updates` and `useSetQueryData()` load on first use,
 * from `./mutationExtras`. Each test starts with the module not loaded.
 */

let loaded: typeof mutationExtras.current;

beforeEach(async () => {
  loaded = mutationExtras.current ?? (await loadLazy(mutationExtras));
  mutationExtras.current = null;
  mutationExtras.loading = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mutationExtras.current = loaded;
  mutationExtras.loading = null;
});

function Providers(props: PropsWithChildren) {
  return (
    <QueryManagerProvider>
      <RouteStateProvider
        state={{ params: {}, prefetchedData: { "/todos": { "": [1] } } } as unknown as RouteState & PageData}
      >
        {props.children}
      </RouteStateProvider>
    </QueryManagerProvider>
  );
}

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: status < 300, status, json: async () => body }) as Response),
  );
}

test("a mutation hook loads them when it mounts, not when the module is imported", async () => {
  const load = vi.spyOn(mutationExtras, "load");
  expect(load).not.toHaveBeenCalled();
  renderHook(() => useMutation("POST" as never, "/posts" as never));
  expect(load).toHaveBeenCalledTimes(1);
  await act(() => loadLazy(mutationExtras));
  expect(mutationExtras.current).not.toBeNull();
});

test("an error that settles before they arrive waits for them", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(mutationExtras, "load").mockImplementation(async () => {
    await gate;
    return loaded!;
  });
  answer(400, { error: { kind: "validation_error", messages: { email: ["Required"] } } });
  const onError = vi.fn();
  const { result } = renderHook(() =>
    useMutation("POST" as never, "/posts" as never, {} as never, { onError } as never),
  );
  let settled = false;
  const pending = act(() => result.current.trigger().then(() => void (settled = true)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  expect(onError).not.toHaveBeenCalled();

  release();
  await pending;
  const [error] = onError.mock.calls[0];
  expect(error.field("email")).toEqual(["Required"]);
  expect(result.current.error).toBe(error);
});

test("if they cannot be loaded, the error is handed over without them and a success still lands", async () => {
  // As Vite's preload helper resolves a chunk whose failure `init`'s recovery
  // handled.
  vi.spyOn(mutationExtras, "load").mockResolvedValue(undefined);
  const onError = vi.fn();
  answer(409, { error: { kind: "form_error", message: "Taken" } });
  const failing = renderHook(() =>
    useMutation("POST" as never, "/posts" as never, {} as never, { onError } as never),
  );
  await act(() => failing.result.current.trigger());
  const [error] = onError.mock.calls[0];
  expect(error).toEqual({ kind: "form_error", message: "Taken", status: 409 });
  expect("list" in error).toBe(false);

  // `updates` cannot be written without them; `onSuccess` still runs.
  const onSuccess = vi.fn();
  answer(200, [1, 2]);
  function View() {
    const { data } = useQuery("/todos" as never, {} as never, { suspense: false } as never);
    const save = useMutation("POST" as never, "/todos" as never, {} as never, {
      updates: [{ path: "/todos" }],
      onSuccess,
    } as never);
    return <button onClick={() => save.trigger()}>{JSON.stringify(data)}</button>;
  }
  render(<View />, { wrapper: Providers });
  await act(async () => {
    screen.getByRole("button").click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(onSuccess).toHaveBeenCalledWith([1, 2]);
  expect(screen.getByRole("button").textContent).toBe("[1]");
});

test("useSetQueryData: a write made before they arrive lands once they have, in order", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(mutationExtras, "load").mockImplementation(async () => {
    await gate;
    return loaded!;
  });
  let setQueryData!: ReturnType<typeof useSetQueryData>;
  function View() {
    setQueryData = useSetQueryData();
    const { data } = useQuery("/todos" as never, {} as never, { suspense: false } as never);
    return <p>{JSON.stringify(data)}</p>;
  }
  render(<View />, { wrapper: Providers });
  act(() => {
    setQueryData({ path: "/todos" as never }, [1, 2] as never);
    setQueryData({ path: "/todos" as never }, ((todos: number[]) => [...todos, 3]) as never);
  });
  expect(screen.getByText("[1]")).toBeDefined();

  await act(async () => {
    release();
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByText("[1,2,3]")).toBeDefined();
});

test("callers while it loads share one load", async () => {
  const load = vi.spyOn(mutationExtras, "load");
  renderHook(() => {
    useMutation("POST" as never, "/posts" as never);
    useSetQueryData();
  });
  await act(() => Promise.all([loadLazy(mutationExtras), loadLazy(mutationExtras)]));
  expect(load).toHaveBeenCalledTimes(1);
});

test("a request superseded while it waits for them writes nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(mutationExtras, "load").mockImplementation(async () => {
    await gate;
    return loaded!;
  });
  const answers = [[1, 2], [9]];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = answers.shift();
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  const onSuccess = vi.fn();
  let save!: () => Promise<unknown>;
  function View() {
    const { data } = useQuery("/todos" as never, {} as never, { suspense: false } as never);
    const mutation = useMutation("POST" as never, "/todos" as never, {} as never, {
      updates: [{ path: "/todos" }],
      onSuccess,
    } as never);
    save = () => mutation.trigger();
    return <p>{JSON.stringify(data)}</p>;
  }
  render(<View />, { wrapper: Providers });
  await act(async () => {
    const first = save();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = save();
    release();
    await Promise.all([first, second]);
  });
  expect(onSuccess.mock.calls).toEqual([[[9]]]);
  expect(screen.getByText("[9]")).toBeDefined();
});
