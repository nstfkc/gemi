import { describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { ServerQueryStore } from "../services/router/ServerQueryStore";
import { INVALIDATE_HEADER, decodeInvalidationKeys } from "../utils/invalidation";
import { Query as TypedQuery } from "./Prefetch";

// The routes are untyped here.
const Query = TypedQuery as unknown as {
  prefill(path: string, options: object, data: unknown): void;
  prefetch(path: string, options?: object): void;
  invalidate(...keys: string[]): void;
};

function request(kind: "view" | "api", path = "/") {
  return new HttpRequest(new Request(`https://app.example${path}`), {}, kind);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("Query.prefill", () => {
  test("ships the handler's data under the query's key without running the route", async () => {
    const fetcher = vi.fn(async () => "from the route");
    const shipped = await RequestContext.run(request("view"), async () => {
      const ctx = RequestContext.getStore();
      ctx.serverQueries = new ServerQueryStore(fetcher);
      // Search keys in any order, nullish ones dropped: one key, as on the client.
      Query.prefill("/records/:collection", {
        params: { collection: "posts" },
        search: { sort: "title", limit: 10, cursor: null },
      }, [{ id: 1 }]);
      Query.prefill("/me", {}, { name: "Ada" });
      // A render that reads the same key joins the prefill.
      const entry = ctx.serverQueries.ensure("/records/:collection", {
        params: { collection: "posts" },
        search: { limit: 10, sort: "title" },
      });
      expect(entry.status).toBe("resolved");
      expect(entry.data).toEqual([{ id: 1 }]);
      return ctx.serverQueries.snapshotResolved();
    });

    expect(shipped).toEqual({
      "/records/posts": { "limit=10&sort=title": [{ id: 1 }] },
      "/me": { "": { name: "Ada" } },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("the first registration of a key wins", async () => {
    await RequestContext.run(request("view"), async () => {
      Query.prefill("/me", {}, { name: "Ada" });
      Query.prefill("/me", {}, { name: "Grace" });
      expect(RequestContext.getStore().serverQueries!.snapshotResolved()).toEqual({
        "/me": { "": { name: "Ada" } },
      });
    });
  });

  test("two requests in flight never see each other's prefills", async () => {
    const serve = (user: string, other: string) =>
      RequestContext.run(request("view", `/${user}`), async () => {
        Query.prefill("/me", {}, { name: user });
        Query.prefill(`/private/${user}`, {}, { secret: user });
        // Let the other request prefill while this one is still running.
        await tick();
        const store = RequestContext.getStore().serverQueries!;
        expect(store.find(`/private/${other}`)).toBeUndefined();
        return store.snapshotResolved();
      });

    const [ada, grace] = await Promise.all([serve("ada", "grace"), serve("grace", "ada")]);

    expect(ada).toEqual({
      "/me": { "": { name: "ada" } },
      "/private/ada": { "": { secret: "ada" } },
    });
    expect(grace).toEqual({
      "/me": { "": { name: "grace" } },
      "/private/grace": { "": { secret: "grace" } },
    });
  });

  test("refuses an API request, like Query.prefetch", () => {
    RequestContext.run(request("api", "/api/me"), () => {
      expect(() => Query.prefill("/me", {}, {})).toThrow(/API request/);
    });
  });
});

describe("Query.invalidate", () => {
  const named = () =>
    decodeInvalidationKeys(RequestContext.getStore().headers.get(INVALIDATE_HEADER));

  test("names the keys in the response header, across calls and without repeats", () => {
    RequestContext.run(request("api", "/api/records/posts"), () => {
      Query.invalidate("/records/posts", "/setup-progress");
      Query.invalidate("/records/posts", "/feeds/*", "/search?q=käse, brot");
      expect(named()).toEqual([
        "/records/posts",
        "/setup-progress",
        "/feeds/*",
        "/search?q=käse, brot",
      ]);
      // A header value has to be ASCII.
      expect(RequestContext.getStore().headers.get(INVALIDATE_HEADER)).toMatch(/^[\x21-\x7e]+$/);
    });
  });

  test("one request's keys stay out of another's answer", async () => {
    const serve = (key: string) =>
      RequestContext.run(request("api", "/api/write"), async () => {
        Query.invalidate(key);
        await tick();
        return named();
      });
    expect(await Promise.all([serve("/a"), serve("/b")])).toEqual([["/a"], ["/b"]]);
  });

  test("a header that is not gemi's decodes to nothing", () => {
    expect(decodeInvalidationKeys(null)).toEqual([]);
    expect(decodeInvalidationKeys("%7B%22a%22%3A1%7D")).toEqual([]);
    expect(decodeInvalidationKeys("%")).toEqual([]);
  });
});
