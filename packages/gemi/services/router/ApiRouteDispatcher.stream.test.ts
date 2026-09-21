import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { AuthManager } from "../../auth/AuthManager";
import { UserProvider } from "../../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../../auth/types";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { AuthenticationMiddleware } from "../../http/AuthenticationMiddlware";
import { Log } from "../../facades/Log";
import type { HttpRequest } from "../../http/HttpRequest";
import { RequestContext } from "../../http/requestContext";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { ServiceProvider } from "../../support/ServiceProvider";

/**
 * A handler whose Response is still running after it returns: the request
 * ends when the body does — read to the end, errored or cancelled — and not
 * before, so the body can still read the user.
 */

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    return args.token === "tok-alice"
      ? ({ token: args.token, user: { id: 1, name: "alice" } } as any)
      : null;
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({}, new StubUsers()));
  }
}

type Store = ReturnType<typeof RequestContext.getStore>;

const ended: string[] = [];
let store: Store | undefined;
let destroyed = 0;
let seen: unknown[] = [];
/** Set by a test whose `onRequestEnd` is a sink that is down. */
let endThrows = false;

/** The request's store, with its `destroy()` counted. */
function capture() {
  store = RequestContext.getStore();
  const destroy = store.destroy.bind(store);
  store.destroy = () => {
    destroyed++;
    destroy();
  };
  return store;
}

const encode = (text: string) => new TextEncoder().encode(text);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Released by a test, to hold a stream open at a point it chooses. */
let release: () => void = () => {};
let innerCancelled = 0;

class RootApiRouter extends ApiRouter {
  routes = {
    // Reads the user between chunks, after an await, as a streamed agent
    // run's tools do.
    "/stream": this.get(() => {
      const ctx = capture();
      let step = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await tick();
            seen.push(ctx.user?.id ?? null);
            controller.enqueue(encode(`chunk ${step}\n`));
            if (++step === 2) controller.close();
          },
        }),
        { headers: { "Content-Type": "text/plain" } },
      );
    }).middleware(["auth"]),
    // Never ends by itself: only a cancel can end it.
    "/forever": this.get(() => {
      capture();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            controller.enqueue(encode("late\n"));
          },
          cancel() {
            innerCancelled++;
          },
        }),
      );
    }),
    "/fails": this.get(() => {
      capture();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull() {
            await tick();
            throw new Error("upstream went away");
          },
        }),
      );
    }),
    "/headers": this.get(() => {
      const ctx = capture();
      ctx.setCookie("flavour", "context");
      ctx.setHeaders("X-From-Context", "yes");
      const headers = new Headers({ "X-From-Handler": "yes" });
      headers.append("Set-Cookie", "flavour2=handler; Path=/");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode("ok"));
            controller.close();
          },
        }),
        { status: 207, statusText: "Multi-Status", headers },
      );
    }),
    // A sized body: its bytes were decided before the handler returned.
    "/sized": this.get(() => {
      capture();
      const blob = new Blob(["0123456789"]);
      return new Response(blob, { headers: { "Content-Length": String(blob.size) } });
    }),
    // A stream route answers HEAD too, and a missing file is an unsized 404.
    "/missing": this.stream(async () => {
      capture();
      return null;
    }),
    // A handler's own Response, unsized, on a route that also answers HEAD.
    "/own": this.stream(async () => {
      capture();
      return new Response("its own body");
    }),
    // A run that starts another before it ends, answered with plain JSON.
    "/nested": this.get(() => {
      const ctx = capture();
      ctx.waitUntil(
        new Promise<void>((resolve) => {
          release = () => {
            ctx.waitUntil(
              new Promise<void>((resolveInner) => {
                release = () => {
                  seen.push(ctx.user?.id ?? null);
                  resolveInner();
                };
              }),
            );
            resolve();
          };
        }),
      );
      return { started: true };
    }).middleware(["auth"]),
    // Work that outlives the body, as a run does once its client has left.
    "/outlives": this.get(() => {
      const ctx = capture();
      ctx.waitUntil(
        new Promise<void>((resolve) => {
          release = () => {
            seen.push(ctx.user?.id ?? null);
            resolve();
          };
        }),
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>(() => {});
          },
        }),
      );
    }).middleware(["auth"]),
  };
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    middleware: { aliases: { auth: AuthenticationMiddleware } },
    route: {
      api: {
        rootRouter: RootApiRouter,
        onRequestEnd: (req: HttpRequest) => {
          ended.push(new URL(req.rawRequest.url).pathname);
          if (endThrows) throw new Error("log sink is down");
        },
      },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
}

const app = new App({ kernel: AppKernel });
const alice = { Cookie: "access_token=tok-alice" };

beforeEach(() => {
  ended.length = 0;
  store = undefined;
  destroyed = 0;
  seen = [];
  innerCancelled = 0;
  endThrows = false;
  release = () => {};
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a streaming response", () => {
  test("its body reads the user after an await", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/stream", { headers: alice }));

    expect(await res.text()).toBe("chunk 0\nchunk 1\n");
    expect(seen).toEqual([1, 1]);
  });

  test("onRequestEnd fires when the body ends, not when the handler returns", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/stream", { headers: alice }));

    expect(ended).toEqual([]);
    expect(destroyed).toBe(0);

    await res.text();

    expect(ended).toEqual(["/api/stream"]);
    expect(destroyed).toBe(1);
    expect(store!.user).toBeUndefined();
  });

  test("whoever reads to the end finds onRequestEnd already run", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/stream", { headers: alice }));
    const reader = res.body!.getReader();

    let atDone: string[] | undefined;
    while (atDone === undefined) {
      const { done } = await reader.read();
      // Checked in the same turn `done` arrives, before anything else runs.
      if (done) atDone = [...ended];
    }

    expect(atDone).toEqual(["/api/stream"]);
    // And only once: an end deferred from an earlier request cannot pass for it.
    await tick();
    expect(ended).toEqual(["/api/stream"]);
  });

  test("an onRequestEnd that throws does not break a body already read, and the store is still released", async () => {
    const logged = vi.spyOn(Log, "error").mockImplementation(() => {});
    endThrows = true;
    const res = await app.fetch(new Request("http://gemi.dev/api/stream", { headers: alice }));

    expect(await res.text()).toBe("chunk 0\nchunk 1\n");
    await tick();
    expect(ended).toEqual(["/api/stream"]);
    expect(destroyed).toBe(1);
    expect(store!.user).toBeUndefined();
    expect(logged).toHaveBeenCalledWith("log sink is down", expect.anything());
  });

  test("a client that cancels ends the request once, and the handler's stream is cancelled", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/forever"));
    const reader = res.body!.getReader();
    // A read in flight when the cancel lands, which then finishes too.
    const read = reader.read();
    await tick();

    await reader.cancel("gone");
    release();
    await read;
    await tick();

    expect(innerCancelled).toBe(1);
    expect(ended).toEqual(["/api/forever"]);
    expect(destroyed).toBe(1);
  });

  test("a body that errors ends the request once, and the reader sees the error", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/fails"));

    await expect(res.text()).rejects.toThrow("upstream went away");
    await tick();

    expect(ended).toEqual(["/api/fails"]);
    expect(destroyed).toBe(1);
  });

  test("keeps the status, the handler's headers and the context's", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/headers"));

    expect(res.status).toBe(207);
    expect(res.statusText).toBe("Multi-Status");
    expect(res.headers.get("X-From-Handler")).toBe("yes");
    expect(res.headers.get("X-From-Context")).toBe("yes");
    expect(res.headers.getSetCookie()).toEqual([
      "flavour2=handler; Path=/",
      expect.stringMatching(/^flavour=context;/),
    ]);
    expect(await res.text()).toBe("ok");
  });

  test("a body with a Content-Length ends with the handler, and keeps its length", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/sized"));

    expect(ended).toEqual(["/api/sized"]);
    expect(destroyed).toBe(1);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await res.text()).toBe("0123456789");
  });

  test("work handed to waitUntil outlives a cancelled body, and still sees the user", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/outlives", { headers: alice }));
    await res.body!.cancel();
    await tick();

    // The body is gone, the work is not: the request is still open.
    expect(ended).toEqual([]);
    expect(destroyed).toBe(0);

    release();
    await tick();

    expect(seen).toEqual([1]);
    expect(ended).toEqual(["/api/outlives"]);
    expect(destroyed).toBe(1);
  });
});

describe("a HEAD request through a real server", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
  });

  afterEach(() => {
    server.stop(true);
  });

  // Bun.serve drops a HEAD response's body without reading or cancelling it,
  // so a body the request waited on would never end it. `app.fetch` alone
  // cannot show this: it hands the body to the test, which reads it.
  test.each(["/api/missing", "/api/own"])("to %s ends the request", async (path) => {
    const res = await fetch(new URL(path, server.url), { method: "HEAD" });
    await res.arrayBuffer();
    await tick();

    expect(ended).toEqual([path]);
    expect(destroyed).toBe(1);
  });

  test("a GET to the same route still ends when its body does", async () => {
    const res = await fetch(new URL("/api/missing", server.url));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    await tick();
    expect(ended).toEqual(["/api/missing"]);
    expect(destroyed).toBe(1);
  });
});

describe("work handed to waitUntil", () => {
  test("holds a plain JSON response's end, including work it starts while waiting", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/nested", { headers: alice }));

    expect(await res.json()).toEqual({ started: true });
    expect(ended).toEqual([]);
    expect(destroyed).toBe(0);

    // The first run settles, having started a second.
    release();
    await tick();
    expect(ended).toEqual([]);
    expect(destroyed).toBe(0);

    release();
    await tick();
    expect(seen).toEqual([1]);
    expect(ended).toEqual(["/api/nested"]);
    expect(destroyed).toBe(1);
  });

  test("is ignored once the request has ended", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/sized"));
    await res.text();
    expect(destroyed).toBe(1);

    store!.waitUntil(new Promise<void>(() => {}));

    expect(store!.hasPendingWork()).toBe(false);
  });
});
