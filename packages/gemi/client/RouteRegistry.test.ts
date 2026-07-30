import { describe, test, expect, vi, afterEach } from "vitest";
import { RouteRegistry, ROUTE_MANIFEST_ENDPOINT } from "./RouteRegistry";

const anonymous = {
  routeManifest: {
    "/": ["PublicLayout", "Home"],
    "/pricing": ["PublicLayout", "Pricing"],
    "/auth/sign-in": ["auth/SignIn"],
  },
  componentTree: [["404", []], ["PublicLayout", [["Home", []], ["Pricing", []]]]] as any,
  loaders: { "404": "/app/views/404.tsx" },
};

const authenticated = {
  routeManifest: {
    ...anonymous.routeManifest,
    "/dashboard": ["AppLayout", "Dashboard"],
    "/products/:id": ["AppLayout", "Product"],
  },
  componentTree: [
    ...anonymous.componentTree,
    ["AppLayout", [["Dashboard", []], ["Product", []]]],
  ] as any,
  loaders: {
    ...anonymous.loaders,
    AppLayout: "/app/views/AppLayout.tsx",
    Dashboard: "/app/views/Dashboard.tsx",
  },
};

function mockFetch(bundle: unknown, { ok = true } = {}) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => bundle }) as any);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("match()", () => {
  test("prefers the most specific pattern", () => {
    const registry = new RouteRegistry({
      ...anonymous,
      routeManifest: {
        "/products/:id": ["Product"],
        "/products/:id/reviews": ["Reviews"],
      },
    });

    expect(registry.match("/products/1")).toBe("/products/:id");
    expect(registry.match("/products/1/reviews")).toBe("/products/:id/reviews");
  });

  test("treats the empty pathname as the root", () => {
    expect(new RouteRegistry(anonymous).match("")).toBe("/");
  });

  test("returns undefined for a path that isn't in the manifest", () => {
    expect(new RouteRegistry(anonymous).match("/dashboard")).toBeUndefined();
  });
});

describe("ensureRoute()", () => {
  test("resolves a known route without asking the server", async () => {
    const fetchMock = mockFetch(authenticated);
    const registry = new RouteRegistry(anonymous);

    expect(await registry.ensureRoute("/pricing")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("picks up routes unlocked by signing in", async () => {
    const fetchMock = mockFetch(authenticated);
    const registry = new RouteRegistry(anonymous);

    // What `push("/dashboard")` right after sign-in hits.
    expect(await registry.ensureRoute("/dashboard")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(ROUTE_MANIFEST_ENDPOINT, expect.anything());
    expect(registry.routeManifest["/dashboard"]).toEqual(["AppLayout", "Dashboard"]);
    expect(registry.componentTree).toEqual(authenticated.componentTree);
  });

  test("refreshes once for a path the server also doesn't know", async () => {
    const fetchMock = mockFetch(anonymous);
    const registry = new RouteRegistry(anonymous);

    expect(await registry.ensureRoute("/nope")).toBe(false);
    expect(await registry.ensureRoute("/nope")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a later refresh reconsiders a path that missed before", async () => {
    const fetchMock = mockFetch(anonymous);
    const registry = new RouteRegistry(anonymous);
    expect(await registry.ensureRoute("/dashboard")).toBe(false);

    mockFetch(authenticated);
    await registry.refresh();

    expect(registry.match("/dashboard")).toBe("/dashboard");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("concurrent misses share a single request", async () => {
    const fetchMock = mockFetch(authenticated);
    const registry = new RouteRegistry(anonymous);

    const results = await Promise.all([
      registry.ensureRoute("/dashboard"),
      registry.ensureRoute("/products/9"),
    ]);

    expect(results).toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("refresh()", () => {
  test("takes routes away again on sign-out", async () => {
    mockFetch(authenticated);
    const registry = new RouteRegistry(anonymous);
    await registry.ensureRoute("/dashboard");

    mockFetch(anonymous);
    await registry.refresh();

    expect(registry.match("/dashboard")).toBeUndefined();
    expect(registry.componentTree).toEqual(anonymous.componentTree);
  });

  test("notifies subscribers exactly once per change", async () => {
    mockFetch(authenticated);
    const registry = new RouteRegistry(anonymous);
    const subscriber = vi.fn();
    registry.subscribe(subscriber);

    await registry.refresh();

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(registry.getBundle().routeManifest).toEqual(authenticated.routeManifest);
  });

  test("keeps the current bundle when the request fails", async () => {
    mockFetch(authenticated, { ok: false });
    const registry = new RouteRegistry(anonymous);

    await registry.refresh();

    expect(registry.routeManifest).toEqual(anonymous.routeManifest);
  });

  test("keeps the current bundle when the network throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const registry = new RouteRegistry(anonymous);

    await expect(registry.refresh()).resolves.toBeDefined();
    expect(registry.routeManifest).toEqual(anonymous.routeManifest);
  });
});
