import { afterEach, describe, expect, test, vi } from "vitest";

import { Auth } from "../facades/Auth";
import { Application } from "../foundation/Application";
import { kernelContext } from "../kernel/context";
import { MiddlewareServiceProvider } from "../services/middleware/MiddlewareServiceProvider";
import { Repository } from "../support/Repository";
import {
  assertChannelPatterns,
  authorizeChannel,
  ChannelDeclaration,
  ChannelRouter,
  type ChannelPolicy,
} from "./ChannelRouter";
import { RequestBreakerError } from "./Error";
import type { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";
import { RequestContext } from "./requestContext";

afterEach(() => {
  vi.restoreAllMocks();
});

const alice = { id: 1, name: "Alice" };

/** Lets in whoever holds the `owner` cookie naming the page. */
class OwnerCookie extends Middleware {
  run() {
    if (this.req.cookies.get("owner") !== this.req.params.pageId) {
      throw new RequestBreakerError("Not the owner", { status: 403 });
    }
    return {};
  }
}

class PagePolicy implements ChannelPolicy {
  authorize(req: HttpRequest<any, any>, { pageId }: Record<string, string>) {
    return req.cookies.get("owner") === pageId;
  }
}

const seen: { user: unknown; params: unknown; path: string }[] = [];

class Channels extends ChannelRouter {
  channels = {
    status: this.public(),
    "site.:siteId": this.private(async (_req, { siteId }) => {
      // Auth.user() reads the subscriber the context carries. (A guest would
      // need the session lookup, which needs a booted app: not in this file.)
      const user = RequestContext.getStore().user ? await Auth.user() : null;
      return user?.id === 1 && siteId === "alices";
    }),
    "page.:pageId": this.private(PagePolicy),
    "owned.:pageId": this.public().middleware("owner-cookie"),
    members: this.private(),
    "probe.:id": this.private((req, params) => {
      seen.push({ user: RequestContext.getStore().user, params, path: req.routePath ?? "" });
      return true;
    }),
    "truthy.:id": this.private(() => 1 as unknown as boolean),
    "broken.:id": this.private(() => {
      throw new Error("db down");
    }),
    user: this.private(),
  };
}

const socketRequest = (cookie?: string) =>
  new Request("http://localhost/__gemi/socket", cookie ? { headers: { Cookie: cookie } } : {});

describe("ChannelRouter.authorize", () => {
  const router = new Channels();

  test("an unknown pattern is refused, raw topics included", async () => {
    expect(await router.authorize(socketRequest(), "nope")).toEqual({
      ok: false,
      code: "unknown_channel",
    });
    expect(await router.authorize(socketRequest(), "site.alices")).toEqual({
      ok: false,
      code: "unknown_channel",
    });
    // Not an own property: never a lookup on the prototype.
    expect(await router.authorize(socketRequest(), "constructor")).toEqual({
      ok: false,
      code: "unknown_channel",
    });
  });

  test("params must be exactly the pattern's, with safe values", async () => {
    expect(await router.authorize(socketRequest(), "site.:siteId", {})).toEqual({
      ok: false,
      code: "invalid_params",
    });
    expect(
      await router.authorize(
        socketRequest(),
        "site.:siteId",
        { siteId: "a.b" },
        { carried: { user: alice } },
      ),
    ).toEqual({ ok: false, code: "invalid_params" });
    expect(
      await router.authorize(socketRequest(), "site.:siteId", { siteId: "a", extra: 1 }),
    ).toEqual({ ok: false, code: "invalid_params" });
    expect(await router.authorize(socketRequest(), "user", { id: 2 })).toEqual({
      ok: false,
      code: "invalid_params",
    });
  });

  test("public lets anyone in, and returns the topic", async () => {
    expect(await router.authorize(socketRequest(), "status")).toEqual({
      ok: true,
      topic: "status",
      pattern: "status",
    });
  });

  test("private without a callback lets in any signed-in user, and no guest", async () => {
    expect(
      await router.authorize(socketRequest(), "members", {}, { carried: { user: alice } }),
    ).toMatchObject({
      ok: true,
      topic: "members",
    });
    expect(await router.authorize(socketRequest(), "members")).toEqual({
      ok: false,
      code: "denied",
    });
  });

  test("a callback decides, with Auth.user() reading the subscriber", async () => {
    expect(
      await router.authorize(
        socketRequest(),
        "site.:siteId",
        { siteId: "alices" },
        { carried: { user: alice } },
      ),
    ).toEqual({ ok: true, topic: "site.alices", pattern: "site.:siteId" });
    expect(
      await router.authorize(
        socketRequest(),
        "site.:siteId",
        { siteId: "bobs" },
        { carried: { user: alice } },
      ),
    ).toEqual({ ok: false, code: "denied" });
    // A guest.
    expect(await router.authorize(socketRequest(), "site.:siteId", { siteId: "alices" })).toEqual({
      ok: false,
      code: "denied",
    });
  });

  test("a policy class decides, and may let a guest in by cookie", async () => {
    expect(
      await router.authorize(socketRequest("owner=p1"), "page.:pageId", { pageId: "p1" }),
    ).toMatchObject({
      ok: true,
      topic: "page.p1",
    });
    expect(
      await router.authorize(socketRequest("owner=p1"), "page.:pageId", { pageId: "p2" }),
    ).toEqual({
      ok: false,
      code: "denied",
    });
  });

  test("only true lets a subscriber in", async () => {
    expect(await router.authorize(socketRequest(), "truthy.:id", { id: "1" })).toEqual({
      ok: false,
      code: "denied",
    });
  });

  test("a callback that throws is logged and refused", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await router.authorize(socketRequest(), "broken.:id", { id: "1" })).toEqual({
      ok: false,
      code: "error",
    });
    expect(String(error.mock.calls[0][0])).toContain('Authorizing the channel "broken.:id" threw');
  });

  test("the callback runs in a fresh request context, never the caller's", async () => {
    seen.length = 0;
    const outer = new Request("http://localhost/api/x");
    const { HttpRequest } = await import("./HttpRequest");
    await RequestContext.run(
      new HttpRequest(outer, {}, "api", "/x"),
      async () => {
        await router.authorize(socketRequest(), "probe.:id", { id: 7 });
      },
      { user: { id: 99 } },
    );
    expect(seen).toEqual([{ user: null, params: { id: "7" }, path: "probe.:id" }]);
  });

  test('"user" joins user.<id> of the signed-in user, and refuses a guest', async () => {
    expect(
      await router.authorize(socketRequest(), "user", {}, { carried: { user: alice } }),
    ).toEqual({
      ok: true,
      topic: "user.1",
      pattern: "user",
    });
    expect(await router.authorize(socketRequest(), "user")).toEqual({ ok: false, code: "denied" });
  });
});

describe("per-pattern middleware", () => {
  async function makeApp() {
    const application = new Application(
      new Repository({ middleware: { aliases: { "owner-cookie": OwnerCookie } } }),
    );
    application.registerMany([MiddlewareServiceProvider]);
    await application.boot();
    return application;
  }

  test("runs before the authorization, and a refusal denies", async () => {
    const application = await makeApp();
    await kernelContext.run(application, async () => {
      const router = new Channels();
      expect(
        await router.authorize(socketRequest("owner=p1"), "owned.:pageId", { pageId: "p1" }),
      ).toMatchObject({
        ok: true,
        topic: "owned.p1",
      });
      expect(
        await router.authorize(socketRequest("owner=p1"), "owned.:pageId", { pageId: "p9" }),
      ).toEqual({
        ok: false,
        code: "denied",
      });
    });
  });
});

describe("authorizeChannel", () => {
  test("as a user, as a request, and as a guest", async () => {
    expect(
      await authorizeChannel(Channels, "site.:siteId", { siteId: "alices" }, { as: alice }),
    ).toBe(true);
    expect(
      await authorizeChannel(Channels, "site.:siteId", { siteId: "bobs" }, { as: alice }),
    ).toBe(false);
    expect(await authorizeChannel(new Channels(), "site.:siteId", { siteId: "alices" })).toBe(
      false,
    );
    expect(
      await authorizeChannel(
        Channels,
        "page.:pageId",
        { pageId: "p1" },
        { as: socketRequest("owner=p1") },
      ),
    ).toBe(true);
    expect(await authorizeChannel(Channels, "status")).toBe(true);
    expect(await authorizeChannel(Channels, "missing")).toBe(false);
  });
});

describe("assertChannelPatterns (review of #875)", () => {
  const router = (channels: Record<string, unknown>) =>
    Object.assign(new ChannelRouter(), { channels }) as ChannelRouter;
  const pub = () => new ChannelDeclaration("public");
  const priv = (cb?: () => boolean) => new ChannelDeclaration("private", cb);

  test("refuses two patterns that can build the same topic", () => {
    expect(() =>
      assertChannelPatterns(router({ "site.:siteId": priv(() => false), "site.:id": pub() })),
    ).toThrow(/can build the same topic/);
    expect(() =>
      assertChannelPatterns(router({ "site.:siteId": priv(() => false), "site.secret": pub() })),
    ).toThrow(/can build the same topic/);
    expect(() =>
      assertChannelPatterns(
        router({
          "site.:siteId": priv(() => true),
          "page.:pageId": priv(() => true),
          "site.:siteId.pages": pub(),
        }),
      ),
    ).not.toThrow();
  });

  test("refuses a pattern that starts with a param", () => {
    expect(() =>
      assertChannelPatterns(router({ "site.:siteId": priv(() => false), ":kind.:id": pub() })),
    ).toThrow(/starts with a param/);
  });

  test("reserves user.<id> for the user channel", () => {
    expect(() =>
      assertChannelPatterns(router({ user: priv(), "user.:userId": priv(() => true) })),
    ).toThrow(/belongs to the "user" channel/);
    expect(() => assertChannelPatterns(router({ "user.settings": pub() }))).toThrow(
      /belongs to the "user" channel/,
    );
    expect(() =>
      assertChannelPatterns(router({ user: priv(), "user.:userId.inbox": priv(() => true) })),
    ).not.toThrow();
  });

  test("refuses a private pattern with params and no authorization", () => {
    expect(() => assertChannelPatterns(router({ "site.:siteId": priv() }))).toThrow(
      /has params but no authorization/,
    );
    expect(() => assertChannelPatterns(router({ members: priv(), user: priv() }))).not.toThrow();
  });

  test("authorizeChannel surfaces a bad router; authorize refuses everything on it", async () => {
    class Overlapping extends ChannelRouter {
      channels = { "site.:siteId": this.private(() => false), ":kind.:id": this.public() };
    }
    await expect(
      authorizeChannel(Overlapping, ":kind.:id", { kind: "site", id: "secret" }),
    ).rejects.toThrow(/starts with a param/);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await new Overlapping().authorize(socketRequest(), ":kind.:id", {
        kind: "site",
        id: "secret",
      }),
    ).toEqual({ ok: false, code: "error" });
    expect(error).toHaveBeenCalled();
  });
});

describe("guests and session failures", () => {
  test("a request with a token whose session lookup fails is an error, not a guest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(Auth, "user").mockRejectedValue(new Error("session store down"));
    expect(await new Channels().authorize(socketRequest("access_token=t"), "members")).toEqual({
      ok: false,
      code: "error",
    });
    expect(error).toHaveBeenCalled();
  });

  test("a token whose session is gone is a guest", async () => {
    const { AuthenticationError } = await import("./errors");
    vi.spyOn(Auth, "user").mockRejectedValue(new AuthenticationError());
    expect(await new Channels().authorize(socketRequest("access_token=t"), "members")).toEqual({
      ok: false,
      code: "denied",
    });
  });

  test('"user" with a user that has no id is refused as an error', async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await new Channels().authorize(
        socketRequest(),
        "user",
        {},
        { carried: { user: { name: "x" } } },
      ),
    ).toEqual({ ok: false, code: "error" });
    expect(error).toHaveBeenCalled();
  });
});
