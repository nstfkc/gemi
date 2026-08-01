import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_STALE_TIME, QueryResource } from "./QueryResource";
import { QueryError } from "./QueryError";

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

  test("ignores absent payloads, but adopts falsy response bodies", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });
    const subscriber = vi.fn();
    resource.store.subscribe(subscriber);

    // No payload at all: nothing to adopt, nothing to notify.
    resource.hydrate(undefined);
    resource.hydrate(null);
    resource.hydrate({});
    expect(subscriber).not.toHaveBeenCalled();
    expect(resource.store.getValue().get("")!.data).toEqual([{ id: 1 }]);

    // `null` is a real response body — the server produced it, so it replaces
    // the cache and marks the variant present. Treating it as "no data" made
    // a falsy body look permanently unfetched, which under suspense meant an
    // unbounded fetch loop.
    resource.hydrate({ "": null });
    expect(subscriber).toHaveBeenCalledTimes(1);
    const state = resource.store.getValue().get("")!;
    expect(state.data).toBeNull();
    expect(state.hasData).toBe(true);
  });

  test("hydrating a falsy body settles a suspended reader", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const resource = new QueryResource("/flag", {});

    const { promise } = resource.read("");
    let settled = false;
    promise!.then(() => {
      settled = true;
    });

    resource.hydrate({ "": false });
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(resource.peek("")!.data).toBe(false);
    expect(resource.peek("")!.hasData).toBe(true);
    vi.unstubAllGlobals();
  });

  test("a resolved falsy body never suspends or refetches on subsequent reads", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => null,
      } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    const resource = new QueryResource("/nullable", {});

    // First read starts the fetch and suspends.
    const first = resource.read("", Infinity);
    expect(first.promise).toBeDefined();
    await first.promise;

    // The retry loop React performs: every subsequent read must see the null
    // body as present — no new promise, no new fetch.
    for (let i = 0; i < 6; i++) {
      const attempt = resource.read("", Infinity);
      expect(attempt.promise).toBeUndefined();
      expect(attempt.state!.hasData).toBe(true);
      expect(attempt.state!.data).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The mount-effect read joins the same conclusion.
    resource.getVariant("", Infinity);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
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

describe("read", () => {
  test("a cold variant returns a promise and one fetch across repeated calls", () => {
    const resource = seeded("/todos", {});

    const results = Array.from({ length: 10 }, () => resource.read(""));

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.promise).toBe(results[0].promise);
      expect(result.state).toBeUndefined();
    }
  });

  test("does not write to the store synchronously", () => {
    const resource = seeded("/todos", {});
    const subscriber = vi.fn();
    resource.store.subscribe(subscriber);

    resource.read("");

    // The render's snapshot must stay valid: no store entry, no notification
    // until the response lands.
    expect(resource.store.getValue().size).toBe(0);
    expect(subscriber).not.toHaveBeenCalled();
  });

  test("fresh data returns state, no promise, no fetch", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    const { state, promise } = resource.read("");

    expect(state!.data).toEqual([{ id: 1 }]);
    expect(promise).toBeUndefined();
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("stale data never suspends — state comes back, revalidation runs behind it", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    vi.setSystemTime(START + DEFAULT_STALE_TIME + 1);
    const { state, promise } = resource.read("");

    expect(state!.data).toEqual([{ id: 1 }]);
    expect(promise).toBeUndefined();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a stale read does not stack a second revalidation on an in-flight one", () => {
    const resource = seeded("/todos", { "": [{ id: 1 }] });

    vi.setSystemTime(START + DEFAULT_STALE_TIME + 1);
    resource.read("");
    resource.read("");

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("the promise resolves when the fetch lands", async () => {
    const resource = seeded("/todos", {});
    let settled = false;

    resource.read("")!.promise!.then(() => {
      settled = true;
    });

    await net.resolve([{ id: 1 }]);
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(resource.peek("")!.data).toEqual([{ id: 1 }]);
  });

  test("hydrate settles a suspended read without waiting on the wire", async () => {
    const resource = seeded("/todos", {});
    let settled = false;

    resource.read("")!.promise!.then(() => {
      settled = true;
    });

    resource.hydrate({ "": [{ id: "prefetched" }] });

    await vi.waitFor(() => expect(settled).toBe(true));
    // The fetch is still pending — the route payload answered first.
    expect(net.pendingCount()).toBe(1);
    expect(resource.peek("")!.data).toEqual([{ id: "prefetched" }]);
  });

  test("a failed fetch settles the promise and leaves a throwable error", async () => {
    const resource = seeded("/todos", {});
    let settled = false;

    resource.read("")!.promise!.then(() => {
      settled = true;
    });

    await net.resolve({ message: "boom" }, false);
    await vi.waitFor(() => expect(settled).toBe(true));

    const { state, promise } = resource.read("");
    expect(promise).toBeUndefined();
    expect(state!.error).toBeInstanceOf(QueryError);
    expect(state!.error.body).toEqual({ message: "boom" });
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a network error settles the promise too", async () => {
    const resource = seeded("/todos", {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as any).fetch = vi.fn(() =>
      Promise.reject(new Error("offline")),
    );
    let settled = false;

    resource.read("")!.promise!.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(settled).toBe(true));
    expect(resource.read("").state!.error).toEqual(new Error("offline"));
  });

  test("getVariant joins an in-flight read instead of racing it", () => {
    const resource = seeded("/todos", {});

    resource.read("");
    resource.getVariant("");

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("refetch bypasses the join — a forced refetch always hits the wire", () => {
    const resource = seeded("/todos", {});

    resource.read("");
    resource.refetch("");

    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("never suspends on the server", () => {
    delete (globalThis as any).window;
    const resource = seeded("/todos", {});

    const { state, promise } = resource.read("");

    expect(state).toBeUndefined();
    expect(promise).toBeUndefined();
    expect(net.fetchMock).not.toHaveBeenCalled();
  });
});

describe("clearError", () => {
  test("drops the stored error so the next read fetches again", async () => {
    const resource = seeded("/todos", {});
    resource.read("");
    await net.resolve({ message: "boom" }, false);

    resource.clearError("");

    const { state, promise } = resource.read("");
    expect(state!.error).toBeNull();
    expect(promise).toBeDefined();
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("notifies subscribers once, and only when something was cleared", async () => {
    const resource = seeded("/todos", {});
    resource.read("");
    await net.resolve({ message: "boom" }, false);

    const subscriber = vi.fn();
    resource.store.subscribe(subscriber);

    resource.clearError();
    expect(subscriber).toHaveBeenCalledTimes(1);

    resource.clearError();
    expect(subscriber).toHaveBeenCalledTimes(1);
  });
});
