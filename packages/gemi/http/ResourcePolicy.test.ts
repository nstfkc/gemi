import { describe, expect, test, vi } from "vitest";

import { InsufficientPermissionsError, NotFoundError } from "./errors";
import { HttpRequest } from "./HttpRequest";
import { defineResourcePolicy } from "./ResourcePolicy";

/**
 * `defineResourcePolicy` on its own (#726): what `authorize` answers, the
 * middleware it gives, and its agent binding. Through a whole `App` in
 * `services/router/ResourcePolicy.routes.test.ts`, and on an agent's routes in
 * `ai/AgentController.resource.test.ts`.
 */

type Page = { id: string; ownerId: number };

const PAGES: Record<string, Page> = {
  p1: { id: "p1", ownerId: 1 },
  p2: { id: "p2", ownerId: 2 },
};

/** The caller, from a header: what `allow` reads off the request. */
const caller = (req: HttpRequest<any, any>) => Number(req.headers.get("x-user"));

function pagePolicy(refuse?: "not_found" | "forbidden") {
  const load = vi.fn((id: string) => PAGES[id] ?? null);
  const policy = defineResourcePolicy({
    param: "pageId",
    load,
    allow: (page, req) => page.ownerId === caller(req),
    refuse,
  });
  return { policy, load };
}

function request(user: number, params: Record<string, string> = {}) {
  const raw = new Request("http://localhost/api/pages", { headers: { "x-user": String(user) } });
  return new HttpRequest(raw, params, "api", "/pages");
}

describe("authorize", () => {
  test("returns the resource to a caller it allows", async () => {
    const { policy } = pagePolicy();
    await expect(policy.authorize(request(1), "p1")).resolves.toEqual(PAGES.p1);
  });

  test("refuses someone else's resource and a missing one with the same 404", async () => {
    const { policy } = pagePolicy();
    const theirs = await policy.authorize(request(1), "p2").catch((e) => e);
    const missing = await policy.authorize(request(1), "nope").catch((e) => e);

    for (const err of [theirs, missing]) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.payload.api).toEqual({
        status: 404,
        data: { error: { kind: "not_found", message: "Not found", status: 404 } },
        headers: { "Cache-Control": "no-store" },
      });
      expect(err.payload.view).toEqual({ status: 404 });
    }
  });

  test('refuses with a 403 for refuse: "forbidden", missing resources included', async () => {
    const { policy } = pagePolicy("forbidden");
    await expect(policy.authorize(request(1), "p2")).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );
    await expect(policy.authorize(request(1), "nope")).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );
  });

  test("refuses an id that is not a string before loading anything", async () => {
    const { policy, load } = pagePolicy();
    for (const id of [undefined, null, "", {}, ["p1"]]) {
      await expect(policy.authorize(request(1), id)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(load).not.toHaveBeenCalled();
  });

  test("passes a numeric id on as its string", async () => {
    const load = vi.fn((id: string) => ({ id, ownerId: 1 }));
    const policy = defineResourcePolicy({ load, allow: () => true });
    await policy.authorize(request(1), 7);
    expect(load).toHaveBeenCalledWith("7", expect.any(HttpRequest));
  });

  test("loads once per request and id, and again for another request", async () => {
    const { policy, load } = pagePolicy();
    const req = request(1);
    await policy.authorize(req, "p1");
    // A middleware and the handler after it get their own `HttpRequest` over
    // the same `Request`.
    await policy.authorize(new HttpRequest(req.rawRequest, {}, "api"), "p1");
    expect(load).toHaveBeenCalledTimes(1);

    await policy.authorize(request(1), "p1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("an error load throws is not a refusal", async () => {
    const policy = defineResourcePolicy({
      load: () => {
        throw new Error("connection refused");
      },
      allow: () => true,
    });
    await expect(policy.authorize(request(1), "p1")).rejects.toThrow("connection refused");
    await expect(policy.allows(request(1), "p1")).rejects.toThrow("connection refused");
  });
});

test("allows answers without throwing", async () => {
  const { policy } = pagePolicy();
  expect(await policy.allows(request(1), "p1")).toBe(true);
  expect(await policy.allows(request(1), "p2")).toBe(false);
  expect(await policy.allows(request(1), "nope")).toBe(false);
  expect(await pagePolicy("forbidden").policy.allows(request(1), "p2")).toBe(false);
});

describe("fromRoute and the middleware", () => {
  test("read the policy's param", async () => {
    const { policy } = pagePolicy();
    await expect(policy.fromRoute(request(1, { pageId: "p1" }))).resolves.toEqual(PAGES.p1);
    await expect(policy.fromRoute(request(2, { pageId: "p1" }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // No param in the route at all.
    await expect(policy.fromRoute(request(1))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the middleware reads another param when its entry names one", async () => {
    const { policy } = pagePolicy();
    const Owns = policy.middleware;
    await expect(new Owns(request(1, { pageId: "p1" })).run()).resolves.toBeUndefined();
    await expect(new Owns(request(1, { id: "p2" })).run("id")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(new Owns(request(2, { id: "p2" })).run("id")).resolves.toBeUndefined();
  });

  test("the middleware is one class, so it can be registered once", () => {
    const { policy } = pagePolicy();
    expect(policy.middleware).toBe(policy.middleware);
  });

  test("a policy without a param says so", () => {
    const policy = defineResourcePolicy({ load: () => null, allow: () => true });
    expect(() => policy.fromRoute(request(1, { pageId: "p1" }))).toThrow(/has no `param`/);
  });
});

describe("forAgent", () => {
  /** p1's thread is t1, p2's is t2. */
  const THREADS: Record<string, string> = { t1: "p1", t2: "p2" };

  function agentResource() {
    const { policy } = pagePolicy();
    return policy.forAgent({
      body: (body: { pageId?: string }) => body.pageId,
      thread: (threadId) => THREADS[threadId] ?? null,
    });
  }

  test("stream and upload: the body's resource", async () => {
    const resource = agentResource();
    for (const route of ["stream", "upload"] as const) {
      await expect(
        resource.authorize(request(1), { route, body: { pageId: "p1" } }),
      ).resolves.toBeUndefined();
      await expect(
        resource.authorize(request(1), { route, body: { pageId: "p2" } }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // A body that names nothing.
      await expect(resource.authorize(request(1), { route, body: {} })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
  });

  test("stream and upload: a thread must be the body's resource's", async () => {
    const resource = agentResource();
    await expect(
      resource.authorize(request(1), { route: "stream", threadId: "t1", body: { pageId: "p1" } }),
    ).resolves.toBeUndefined();
    // Your own page, someone else's thread.
    await expect(
      resource.authorize(request(1), { route: "stream", threadId: "t2", body: { pageId: "p1" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A thread nobody knows.
    await expect(
      resource.authorize(request(1), { route: "upload", threadId: "tx", body: { pageId: "p1" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("attach and stop: the thread's resource", async () => {
    const resource = agentResource();
    for (const route of ["attach", "stop"] as const) {
      await expect(
        resource.authorize(request(1), { route, threadId: "t1" }),
      ).resolves.toBeUndefined();
      await expect(resource.authorize(request(1), { route, threadId: "t2" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(resource.authorize(request(1), { route, threadId: "tx" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
  });

  test("a stop that names no thread is left to runOwner", async () => {
    await expect(agentResource().authorize(request(1), { route: "stop" })).resolves.toBeUndefined();
  });

  test("without a thread mapper, a request that names a thread is refused", async () => {
    const { policy } = pagePolicy();
    const resource = policy.forAgent({ body: (body: { pageId: string }) => body.pageId });
    await expect(
      resource.authorize(request(1), { route: "stream", body: { pageId: "p1" } }),
    ).resolves.toBeUndefined();
    await expect(
      resource.authorize(request(1), { route: "stream", threadId: "t1", body: { pageId: "p1" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      resource.authorize(request(1), { route: "attach", threadId: "t1" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the mappers may be async and compare ids as strings", async () => {
    const policy = defineResourcePolicy({
      load: (id) => ({ id: Number(id), ownerId: 1 }),
      allow: (site, req) => site.ownerId === caller(req),
    });
    // A body that names a page, a thread that belongs to the page's site.
    const resource = policy.forAgent({
      body: async (body: { pageId: string }) => (body.pageId === "p1" ? 10 : 20),
      thread: async () => "10",
    });
    await expect(
      resource.authorize(request(1), { route: "stream", threadId: "t", body: { pageId: "p1" } }),
    ).resolves.toBeUndefined();
    await expect(
      resource.authorize(request(1), { route: "stream", threadId: "t", body: { pageId: "p9" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
