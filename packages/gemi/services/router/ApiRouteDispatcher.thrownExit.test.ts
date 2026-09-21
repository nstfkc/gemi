import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { app as resolve } from "../../foundation/app";
import { ApiRouter } from "../../http/ApiRouter";
import { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { RequestContext } from "../../http/requestContext";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { ApiRouteDispatcher } from "./ApiRouteDispatcher";

/**
 * A request that fails with a thrown error — the server's 500 — still ends:
 * `onRequestFail`, then `onRequestEnd`, then `destroy()`, each once, and the
 * error still reaches whoever called `handleApiRequest`.
 */

type Store = ReturnType<typeof RequestContext.getStore>;

/** Every hook call and every destroy(), in order, as `<what>:<pathname>`. */
const log: string[] = [];
const stores: Store[] = [];
/** Set by a test whose `onRequestEnd` is a sink that is down. */
let endThrows = false;

/** The request's store, with its `destroy()` logged. */
function capture() {
  const store = RequestContext.getStore();
  const path = new URL(store.req.rawRequest.url).pathname;
  const destroy = store.destroy.bind(store);
  store.destroy = () => {
    log.push(`destroy:${path}`);
    destroy();
  };
  stores.push(store);
  return store;
}

class Throws extends Middleware {
  run(): {} {
    capture();
    throw new Error("middleware broke");
  }
}

const encode = (text: string) => new TextEncoder().encode(text);
let releaseWork: () => void = () => {};
let inside: (req: HttpRequest<any, any>) => Promise<unknown> = async () => ({});

class RootApiRouter extends ApiRouter {
  routes = {
    "/handler-throws": this.get(() => {
      capture();
      throw new Error("handler broke");
    }),
    "/middleware-throws": this.get(() => {
      log.push("handler:/api/middleware-throws");
      return {};
    }).middleware(["throws"]),
    // Framework routes stay out of the app's hooks; one here shows the throw
    // path keeps that rule and still destroys the store.
    "/__gemi__/throws": this.get(() => {
      capture();
      throw new Error("framework route broke");
    }),
    // Work handed to waitUntil holds the end back on this path too.
    "/throws-with-work": this.get(() => {
      const store = capture();
      store.waitUntil(new Promise<void>((resolve) => (releaseWork = resolve)));
      throw new Error("handler broke");
    }),
    "/ok": this.get(() => {
      capture();
      return { ok: true };
    }),
    "/stream": this.get(() => {
      const store = capture();
      let step = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            // The body still sees the store: nothing ended the request early.
            controller.enqueue(encode(`${store.headers ? "open" : "destroyed"}\n`));
            if (++step === 2) controller.close();
          },
        }),
        { headers: { "Content-Type": "text/plain" } },
      );
    }),
    "/stream-errors": this.get(() => {
      capture();
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("stream broke"));
          },
        }),
      );
    }),
    "/agent": this.post(() => inside(new HttpRequest<any, any>())),
  };
}

class AppKernel extends Kernel {
  config = {
    middleware: { aliases: { throws: Throws } },
    route: {
      api: {
        rootRouter: RootApiRouter,
        onRequestStart: (req: HttpRequest) => {
          log.push(`start:${new URL(req.rawRequest.url).pathname}`);
        },
        onRequestEnd: (req: HttpRequest) => {
          log.push(`end:${new URL(req.rawRequest.url).pathname}`);
          if (endThrows) {
            throw new Error("log sink down");
          }
        },
        onRequestFail: (req: HttpRequest, error: unknown) => {
          log.push(`fail:${new URL(req.rawRequest.url).pathname}:${(error as Error).message}`);
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

function direct(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://gemi.dev/api${path}`, init));
}

beforeEach(() => {
  log.length = 0;
  stores.length = 0;
  endThrows = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a request that fails with a thrown error", () => {
  test("from its handler runs onRequestFail, then onRequestEnd, then destroy(), once each", async () => {
    await expect(direct("/handler-throws")).rejects.toThrow("handler broke");

    expect(log).toEqual([
      "start:/api/handler-throws",
      "fail:/api/handler-throws:handler broke",
      "end:/api/handler-throws",
      "destroy:/api/handler-throws",
    ]);
    expect(stores[0]!.headers).toBeUndefined();
    expect(stores[0]!.cookies).toBeUndefined();
    expect(stores[0]!.ended).toBe(true);
  });

  test("from a middleware ends the same way, and the handler never runs", async () => {
    await expect(direct("/middleware-throws")).rejects.toThrow("middleware broke");

    expect(log).toEqual([
      "start:/api/middleware-throws",
      "fail:/api/middleware-throws:middleware broke",
      "end:/api/middleware-throws",
      "destroy:/api/middleware-throws",
    ]);
    expect(stores[0]!.headers).toBeUndefined();
  });

  test("on a /__gemi__ route fires no app hooks, and still destroys the store", async () => {
    await expect(direct("/__gemi__/throws")).rejects.toThrow("framework route broke");

    // onRequestFail is not a start/end hook and was never filtered here.
    expect(log).toEqual([
      "fail:/api/__gemi__/throws:framework route broke",
      "destroy:/api/__gemi__/throws",
    ]);
  });

  test("keeps the thrown error when onRequestEnd throws too", async () => {
    endThrows = true;

    await expect(direct("/handler-throws")).rejects.toThrow("handler broke");

    expect(log).toEqual([
      "start:/api/handler-throws",
      "fail:/api/handler-throws:handler broke",
      "end:/api/handler-throws",
      "destroy:/api/handler-throws",
    ]);
  });

  test("waits for work handed to waitUntil before it ends", async () => {
    await expect(direct("/throws-with-work")).rejects.toThrow("handler broke");

    expect(log).toEqual([
      "start:/api/throws-with-work",
      "fail:/api/throws-with-work:handler broke",
    ]);

    releaseWork();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(log.slice(2)).toEqual(["end:/api/throws-with-work", "destroy:/api/throws-with-work"]);
  });
});

describe("a request that ends without a throw", () => {
  test("whose onRequestEnd throws is not ended a second time", async () => {
    endThrows = true;

    await expect(direct("/ok")).rejects.toThrow("log sink down");

    expect(log).toEqual(["start:/api/ok", "end:/api/ok", "destroy:/api/ok"]);
  });

  test("with a streaming body is ended once, by its body, after the body is read", async () => {
    const res = await direct("/stream");
    expect(log).toEqual(["start:/api/stream"]);

    expect(await res.text()).toBe("open\nopen\n");
    expect(log).toEqual(["start:/api/stream", "end:/api/stream", "destroy:/api/stream"]);
  });

  test("with a streaming body that errors is ended once", async () => {
    const res = await direct("/stream-errors");

    await expect(res.text()).rejects.toThrow("stream broke");
    expect(log).toEqual([
      "start:/api/stream-errors",
      "end:/api/stream-errors",
      "destroy:/api/stream-errors",
    ]);
  });
});

describe("a dispatchAs call that throws", () => {
  test("ends the inner request and hands its caller the error", async () => {
    let thrown: unknown;
    inside = async (req) => {
      try {
        await resolve(ApiRouteDispatcher).dispatchAs(req, "GET", "/handler-throws");
      } catch (err) {
        thrown = err;
      }
      // The inner request has ended by now; the outer one has not.
      log.push("caller resumes");
      return {};
    };

    const outer = await direct("/agent", { method: "POST" });

    expect(outer.status).toBe(200);
    expect((thrown as Error).message).toBe("handler broke");
    expect(log).toEqual([
      "start:/api/agent",
      "start:/api/handler-throws",
      "fail:/api/handler-throws:handler broke",
      "end:/api/handler-throws",
      "destroy:/api/handler-throws",
      "caller resumes",
      "end:/api/agent",
    ]);
  });
});
