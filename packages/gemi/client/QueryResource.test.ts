import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_STALE_TIME, QueryResource } from "./QueryResource";

const START = 1_700_000_000_000;

/**
 * `resolveVariant` bails out when `window` is undefined, and vitest runs with
 * the default node environment, so every test needs a stub. `mutate` also reads
 * `window.location.origin` while building its CacheStorage key.
 */
function stubWindow() {
  (globalThis as any).window = { location: { origin: "https://example.test" } };
}

/**
 * A `fetch` stub whose responses are resolved by the test, so the window
 * between "request started" and "request landed" can be inspected.
 */
function createFetch() {
  const pending: Array<(value: { ok: boolean; body: any }) => void> = [];
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
    return new Promise((resolve) => {
      pending.push(({ ok, body }) =>
        resolve({ ok, json: async () => body } as Response),
      );
    });
  });
  (globalThis as any).fetch = fetchMock;

  return {
    fetchMock,
    urls: () => fetchMock.mock.calls.map(([url]) => url as string),
    /** Resolve the oldest in-flight request and let the microtask queue drain. */
    async resolve(body: any, ok = true) {
      const settle = pending.shift();
      if (!settle) throw new Error("No pending fetch to resolve");
      settle({ ok, body });
      await vi.waitFor(() => {});
    },
    pendingCount: () => pending.length,
  };
}

/** Seed a resource the way SSR does, then let its initial fetch settle. */
function seeded(key: string, initialState: Record<string, any>) {
  return new QueryResource(key, initialState);
}

let net: ReturnType<typeof createFetch>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  stubWindow();
  net = createFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as any).window;
  delete (globalThis as any).fetch;
});

describe("getVariant staleTime", () => {
  test("does not revalidate within the default window", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    vi.setSystemTime(START + DEFAULT_STALE_TIME - 1);
    resource.getVariant("");

    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("revalidates once the default window elapses", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    vi.setSystemTime(START + DEFAULT_STALE_TIME + 1);
    resource.getVariant("");

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    expect(net.urls()).toEqual(["/api/todos"]);
  });

  test("builds the variant into the request url", () => {
    const resource = seeded("/todos", { "page=2": [{ id: 2 }] });

    vi.setSystemTime(START + DEFAULT_STALE_TIME + 1);
    resource.getVariant("page=2");

    expect(net.urls()).toEqual(["/api/todos?page=2"]);
  });

  test("a larger staleTime suppresses the revalidation", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    vi.setSystemTime(START + 30_000);
    resource.getVariant("", 60_000);

    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("a smaller staleTime triggers the revalidation", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    vi.setSystemTime(START + 30_000);
    resource.getVariant("", 10_000);

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("staleTime 0 always revalidates, even in the same tick", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    resource.getVariant("", 0);

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("staleTime Infinity never revalidates on age", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    vi.setSystemTime(START + 10_000_000);
    resource.getVariant("", Number.POSITIVE_INFINITY);

    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("staleTime gates only the age branch, not explicit staleness", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });
    resource.staleVariants.add("");

    resource.getVariant("", Number.POSITIVE_INFINITY);

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("hydrate", () => {
  test("adopting fresh prefetched data prevents the refetch (issue #272)", async () => {
    const resource = seeded("/organization", { "": { name: "Acme" } });

    // Data ages past the stale window, as it does between two navigations.
    vi.setSystemTime(START + 10_000);
    resource.hydrate({ "": { name: "Acme Corp" } });

    const state = resource.getVariant("");

    expect(net.fetchMock).not.toHaveBeenCalled();
    expect(state.data).toEqual({ name: "Acme Corp" });
  });

  test("writes every variant and notifies subscribers exactly once", () => {
    const resource = seeded("/todos", {});
    const subscriber = vi.fn();
    resource.store.subscribe(subscriber);

    resource.hydrate({ "": [{ id: 1 }], "page=2": [{ id: 2 }] });

    expect(subscriber).toHaveBeenCalledTimes(1);
    const store = resource.store.getValue();
    expect(store.get("")!.data).toEqual([{ id: 1 }]);
    expect(store.get("page=2")!.data).toEqual([{ id: 2 }]);
  });

  test("skips a variant with a fetch in flight, and the network value wins", async () => {
    const resource = seeded("/todos", {});

    // Cold read starts a fetch and leaves the variant `loading`.
    resource.getVariant("");
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    resource.hydrate({ "": [{ id: "hydrated" }] });
    expect(resource.store.getValue().get("")!.loading).toBe(true);
    expect(resource.store.getValue().get("")!.data).toBeUndefined();

    await net.resolve([{ id: "network" }]);
    expect(resource.store.getValue().get("")!.data).toEqual([
      { id: "network" },
    ]);
  });

  test("skips a variant with an optimistic mutate in flight", () => {
    const resource = seeded("/todos", { "": [{ id: 1, done: false }] });

    resource.mutate("", (todos: any[]) =>
      todos.map((t) => ({ ...t, done: true })),
    );

    resource.hydrate({ "": [{ id: 1, done: false }] });

    const state = resource.store.getValue().get("")!;
    expect(state.data).toEqual([{ id: 1, done: true }]);
    // The pending refetch still needs to reconcile, so staleness must survive.
    expect(resource.staleVariants.has("")).toBe(true);
  });

  test("clears the error and the stale flag for variants it writes", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });
    const store = resource.store.getValue();
    store.set("", {
      loading: false,
      data: [{ id: 1 }],
      error: { message: "boom" },
      version: 1,
    });
    resource.staleVariants.add("");

    resource.hydrate({ "": [{ id: 2 }] });

    expect(resource.store.getValue().get("")!.error).toBeNull();
    expect(resource.staleVariants.has("")).toBe(false);
  });

  test("resets lastFetchRecord and stamps a fresh version", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });
    const originalVersion = resource.store.getValue().get("")!.version;

    vi.setSystemTime(START + 60_000);
    resource.hydrate({ "": [{ id: 2 }] });

    expect(resource.lastFetchRecord.get("")).toBe(START + 60_000);
    expect(resource.store.getValue().get("")!.version).toBe(START + 60_000);
    expect(resource.store.getValue().get("")!.version).not.toBe(
      originalVersion,
    );
  });

  test("ignores empty, nullish and falsy payloads without notifying", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });
    const subscriber = vi.fn();
    resource.store.subscribe(subscriber);

    resource.hydrate(undefined);
    resource.hydrate(null);
    resource.hydrate({});
    resource.hydrate({ "": null });

    expect(subscriber).not.toHaveBeenCalled();
    expect(resource.store.getValue().get("")!.data).toEqual([{ id: 1 }]);
  });

  test("re-hydrating the identical data reference is a no-op", () => {
    const data = [{ id: 1 }];
    const resource = seeded("/todos", { "": data });
    const subscriber = vi.fn();
    resource.store.subscribe(subscriber);

    resource.hydrate({ "": data });

    expect(subscriber).not.toHaveBeenCalled();
  });

  test("matches the constructor, which now delegates to it", () => {
    const initialState = { "": [{ id: 1 }], "page=2": [{ id: 2 }] };

    const viaConstructor = new QueryResource("/todos", initialState);
    const viaHydrate = new QueryResource("/todos", {});
    viaHydrate.hydrate(initialState);

    expect([...viaHydrate.store.getValue()]).toEqual([
      ...viaConstructor.store.getValue(),
    ]);
    expect([...viaHydrate.lastFetchRecord]).toEqual([
      ...viaConstructor.lastFetchRecord,
    ]);
  });
});

describe("peek", () => {
  test("returns the cached state", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    expect(resource.peek("")).toEqual(resource.store.getValue().get(""));
  });

  test("returns undefined for a variant that was never fetched", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    expect(resource.peek("page=2")).toBeUndefined();
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("does not fetch for a cold variant, where getVariant would", () => {
    const resource = seeded("/todos", {});

    resource.peek("");
    expect(net.fetchMock).not.toHaveBeenCalled();

    resource.getVariant("");
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not revalidate data past its stale window, where getVariant would", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });
    vi.setSystemTime(START + DEFAULT_STALE_TIME + 1);

    expect(resource.peek("")!.data).toEqual([{ id: 1 }]);
    expect(net.fetchMock).not.toHaveBeenCalled();

    resource.getVariant("");
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not revalidate a variant flagged stale, where getVariant would", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });
    resource.staleVariants.add("");

    resource.peek("");
    expect(net.fetchMock).not.toHaveBeenCalled();
    expect(resource.staleVariants.has("")).toBe(true);
  });

  test("never writes to the store", () => {
    const resource = seeded("/todos", {});
    const subscriber = vi.fn();
    resource.store.subscribe(subscriber);

    resource.peek("");
    resource.peek("page=2");

    expect(resource.store.getValue().size).toBe(0);
    expect(subscriber).not.toHaveBeenCalled();
  });
});
