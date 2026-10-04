import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { ApiRouter } from "./ApiRouter";
import { bodyLimitOf, parseByteSize, PayloadTooLargeError, setBodyLimit } from "./bodyLimit";
import { HttpRequest } from "./HttpRequest";
import { ViewRouter } from "./ViewRouter";

/** Per-route request body limits: `body-limit:<size>` and `bodyLimit` (#752). */

const LIMIT = 64;
const under = "a".repeat(LIMIT - 10);
const over = "a".repeat(LIMIT * 4);

/** In-process, a Request does not get a Content-Length; a client's does. */
const declared = (body: string | Uint8Array) => ({
  "Content-Length": String(
    typeof body === "string" ? new TextEncoder().encode(body).length : body.byteLength,
  ),
});

const tooLarge = {
  error: { kind: "form_error", message: "The request body is too large.", status: 413 },
};

/** A body with no length, as a chunked upload sends it. */
function chunked(text: string, chunkSize = 16) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

describe("parseByteSize", () => {
  test.each([
    ["512", 512],
    [512, 512],
    ["64kb", 64 * 1024],
    ["64KB", 64 * 1024],
    ["64k", 64 * 1024],
    ["1.5mb", 1.5 * 1024 * 1024],
    ["2 MB", 2 * 1024 * 1024],
    ["1gb", 1024 ** 3],
    ["10b", 10],
    ["none", Infinity],
    ["off", Infinity],
  ])("%j is %d bytes", (input, bytes) => {
    expect(parseByteSize(input)).toBe(bytes);
  });

  test.each(["", "kb", "64xb", "-1", "1e3", "lots", -5, NaN])("%j throws", (input) => {
    expect(() => parseByteSize(input as any)).toThrow(/Invalid body limit/);
  });
});

describe("setBodyLimit on a Request", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("http://gemi.dev/api/x", { method: "POST", body, headers });

  test("a declared length over the limit is refused before anything is read", () => {
    const req = post(over, declared(over));
    expect(() => setBodyLimit(req, LIMIT)).toThrow(PayloadTooLargeError);
    expect(req.bodyUsed).toBe(false);
  });

  test("checkDeclared: false defers the length check to the read", async () => {
    const req = post(over, declared(over));
    setBodyLimit(req, LIMIT, { checkDeclared: false });
    await expect(req.text()).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  test("a body within the limit reads through every accessor", async () => {
    const make = () => {
      const req = post(under, { "Content-Type": "text/plain" });
      setBodyLimit(req, LIMIT);
      return req;
    };
    expect(await make().text()).toBe(under);
    expect(new TextDecoder().decode(await make().arrayBuffer())).toBe(under);
    expect(new TextDecoder().decode(await make().bytes())).toBe(under);
    const blob = await make().blob();
    expect(blob.type).toMatch(/^text\/plain/);
    expect(await blob.text()).toBe(under);
    expect(await new Response(make().body).text()).toBe(under);
    const json = post(JSON.stringify({ a: 1 }));
    setBodyLimit(json, LIMIT);
    expect(await json.json()).toEqual({ a: 1 });
  });

  test("a chunked body is cut off at the limit, with nothing past it buffered", async () => {
    let pulled = 0;
    const source = chunked(over.repeat(100));
    const counting = source.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
    const req = new Request("http://gemi.dev/api/x", {
      method: "POST",
      body: counting,
      // @ts-expect-error not in the DOM lib's RequestInit
      duplex: "half",
    });
    setBodyLimit(req, LIMIT);
    await expect(req.text()).rejects.toBeInstanceOf(PayloadTooLargeError);
    // One chunk past the limit at most, and a little read-ahead: nowhere near
    // the 25 KB the client offered.
    expect(pulled).toBeLessThan(LIMIT * 4);
  });

  test("a Content-Length that understates the body does not get it past the counter", async () => {
    const req = post(over, { "Content-Length": "10" });
    setBodyLimit(req, LIMIT);
    await expect(req.text()).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  test("touching body does not consume it; reading twice fails like the native one", async () => {
    const req = post(under);
    setBodyLimit(req, LIMIT);
    expect(req.body).not.toBeNull();
    expect(req.bodyUsed).toBe(false);
    expect(await req.text()).toBe(under);
    expect(req.bodyUsed).toBe(true);
    await expect(req.text()).rejects.toThrow(TypeError);
  });

  test("a clone shares the counter", async () => {
    const req = new Request("http://gemi.dev/api/x", {
      method: "POST",
      body: chunked(over),
      // @ts-expect-error not in the DOM lib's RequestInit
      duplex: "half",
    });
    setBodyLimit(req, LIMIT);
    const copy = req.clone();
    await expect(copy.text()).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  test("installing again replaces the limit", async () => {
    const req = post(over);
    setBodyLimit(req, LIMIT, { checkDeclared: false });
    setBodyLimit(req, Infinity);
    expect(bodyLimitOf(req)).toBe(Infinity);
    expect(await req.text()).toBe(over);
  });

  test("a bodiless request reads as empty", async () => {
    const req = new Request("http://gemi.dev/api/x", { method: "POST" });
    setBodyLimit(req, LIMIT);
    expect(await req.text()).toBe("");
  });
});

describe("through the API router", () => {
  const handled = vi.fn();

  class PublicApiRouter extends ApiRouter {
    middlewares = [`body-limit:${LIMIT}`];
    routes = {
      "/input": this.post(async () => {
        handled();
        return (await new HttpRequest<any, any>().input()).toJSON();
      }),
      "/raw": this.post(async () => {
        handled();
        return { text: await new HttpRequest<any, any>().rawRequest.text() };
      }),
      "/big": this.post(async () => {
        return { text: await new HttpRequest<any, any>().rawRequest.text() };
      }).middleware(`body-limit:${LIMIT * 8}`),
      "/unlimited": this.post(async () => {
        return { text: await new HttpRequest<any, any>().rawRequest.text() };
      }).middleware("body-limit:none"),
    };
  }

  class RootApiRouter extends ApiRouter {
    routes = {
      "/public": PublicApiRouter,
      "/default": this.post(async () => {
        return { text: await new HttpRequest<any, any>().rawRequest.text() };
      }),
      "/default-raised": this.post(async () => {
        return { text: await new HttpRequest<any, any>().rawRequest.text() };
      }).middleware(`body-limit:${LIMIT * 8}`),
    };
  }

  const makeApp = (bodyLimit: number | string | null = null) => {
    class AppKernel extends Kernel {
      config = {
        // No `body-limit` alias: it is built in.
        middleware: { aliases: {}, bodyLimit },
        route: {
          api: { rootRouter: RootApiRouter },
          view: {
            root: createRoot(() => createElement("div")),
            rootRouter: class extends ViewRouter {},
          },
        },
      };
    }
    return new App({ kernel: AppKernel });
  };

  const app = makeApp();
  const send = (target: App, path: string, body: BodyInit, headers: Record<string, string> = {}) =>
    target.fetch(
      new Request(`http://gemi.dev/api${path}`, {
        method: "POST",
        body,
        headers,
        // @ts-expect-error not in the DOM lib's RequestInit
        duplex: "half",
      }),
    );

  beforeEach(() => {
    handled.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each([
    ["JSON", "application/json", (v: string) => JSON.stringify({ v })],
    ["urlencoded", "application/x-www-form-urlencoded", (v: string) => `v=${v}`],
  ])("%s", (_, type, encode) => {
    test("within the limit reaches the handler", async () => {
      const res = await send(app, "/public/input", encode(under.slice(20)), {
        "Content-Type": type,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ v: under.slice(20) });
    });

    test("a declared length over it is a 413 before the handler runs", async () => {
      const res = await send(app, "/public/input", encode(over), {
        "Content-Type": type,
        ...declared(encode(over)),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(tooLarge);
      expect(handled).not.toHaveBeenCalled();
    });

    test("chunked, over it is a 413", async () => {
      const res = await send(app, "/public/input", chunked(encode(over)), {
        "Content-Type": type,
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(tooLarge);
    });

    test("chunked, within it reaches the handler", async () => {
      const res = await send(app, "/public/input", chunked(encode(under.slice(20)), 4), {
        "Content-Type": type,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ v: under.slice(20) });
    });
  });

  describe("multipart", () => {
    const form = (value: string) => {
      const data = new FormData();
      data.set("v", value);
      return new Response(data);
    };

    test("over it is a 413, declared or chunked", async () => {
      const body = form(over);
      const type = body.headers.get("Content-Type")!;
      const bytes = new Uint8Array(await body.arrayBuffer());
      let res = await send(app, "/public/input", bytes, {
        "Content-Type": type,
        ...declared(bytes),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(tooLarge);
      res = await send(app, "/public/input", chunked(new TextDecoder().decode(bytes)), {
        "Content-Type": type,
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(tooLarge);
    });

    test("within it parses", async () => {
      const body = form("hi");
      const type = body.headers.get("Content-Type")!;
      const bytes = await body.arrayBuffer();
      class Router extends ApiRouter {
        routes = {
          "/f": this.post(async () =>
            (await new HttpRequest<any, any>().input()).toJSON(),
          ).middleware(`body-limit:${bytes.byteLength}`),
        };
      }
      class AppKernel extends Kernel {
        config = {
          route: {
            api: { rootRouter: Router },
            view: {
              root: createRoot(() => createElement("div")),
              rootRouter: class extends ViewRouter {},
            },
          },
        };
      }
      const res = await send(
        new App({ kernel: AppKernel }),
        "/f",
        chunked(new TextDecoder().decode(bytes)),
        {
          "Content-Type": type,
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ v: "hi" });
    });
  });

  describe("raw bodies, read off rawRequest", () => {
    test("within the limit", async () => {
      const res = await send(app, "/public/raw", under, { "Content-Type": "text/plain" });
      expect(await res.json()).toEqual({ text: under });
    });

    test("declared over it never reaches the handler", async () => {
      const res = await send(app, "/public/raw", over, declared(over));
      expect(res.status).toBe(413);
      expect(handled).not.toHaveBeenCalled();
    });

    test("chunked over it is a 413", async () => {
      const res = await send(app, "/public/raw", chunked(over));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(tooLarge);
    });

    test("a Content-Length lower than the body is no way past it", async () => {
      const res = await send(app, "/public/raw", over, { "Content-Length": "10" });
      expect(res.status).toBe(413);
    });
  });

  test("a route's body-limit replaces its router's", async () => {
    const res = await send(app, "/public/big", chunked(over));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: over });
    expect((await send(app, "/public/unlimited", over.repeat(10))).status).toBe(200);
  });

  test("no limit at all leaves the body alone", async () => {
    const res = await send(app, "/default", chunked(over.repeat(10)));
    expect(res.status).toBe(200);
  });

  describe("the app-wide bodyLimit", () => {
    const limited = makeApp(`${LIMIT}b`);

    test("applies to a route without its own", async () => {
      let res = await send(limited, "/default", over, declared(over));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(tooLarge);
      res = await send(limited, "/default", chunked(over));
      expect(res.status).toBe(413);
      res = await send(limited, "/default", under);
      expect(res.status).toBe(200);
    });

    test("a route's body-limit can raise it, declared length included", async () => {
      const res = await send(limited, "/default-raised", over, declared(over));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: over });
    });

    test("an invalid one is refused when the registry is built, not per request", async () => {
      const broken = makeApp("lots");
      await expect(broken.fetch(new Request("http://gemi.dev/api/default"))).rejects.toThrow(
        /Invalid body limit/,
      );
    });
  });

  describe("on a real server", () => {
    let server: ReturnType<typeof Bun.serve>;

    beforeAll(() => {
      server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
    });
    afterAll(() => {
      server.stop(true);
    });

    /** Writes `raw` to the server and answers the response's status line and body. */
    async function rawExchange(raw: string) {
      const { promise, resolve } = Promise.withResolvers<string>();
      let received = "";
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port: server.port!,
        socket: {
          data(_, data) {
            received += data.toString();
            if (/\r\n\r\n[\s\S]*\}/.test(received)) resolve(received);
          },
          close() {
            resolve(received);
          },
          error() {
            resolve(received);
          },
        },
      });
      socket.write(raw);
      const response = await promise;
      socket.end();
      return {
        status: Number(response.split(" ")[1]),
        body: response.slice(response.indexOf("\r\n\r\n") + 4),
      };
    }

    test("a chunked body over the limit is answered with a 413", async () => {
      const chunks = Array.from({ length: 20 }, () => `10\r\n${"a".repeat(16)}\r\n`).join("");
      const res = await rawExchange(
        "POST /api/public/raw HTTP/1.1\r\nHost: gemi.dev\r\nTransfer-Encoding: chunked\r\n\r\n" +
          chunks +
          "0\r\n\r\n",
      );
      expect(res.status).toBe(413);
      expect(res.body).toContain('"status":413');
    });

    test("a Content-Length over the limit is refused without the body being sent", async () => {
      const res = await rawExchange(
        "POST /api/public/raw HTTP/1.1\r\nHost: gemi.dev\r\nContent-Length: 100000000\r\n\r\n",
      );
      expect(res.status).toBe(413);
    });

    test("bytes past a short Content-Length are not read as the body", async () => {
      const res = await rawExchange(
        `POST /api/public/raw HTTP/1.1\r\nHost: gemi.dev\r\nContent-Length: 5\r\nConnection: close\r\n\r\n${over}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"text":"aaaaa"');
    });
  });
});

describe("a proxy route", () => {
  let upstream: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    upstream = Bun.serve({
      port: 0,
      fetch: async (req) => new Response(await req.text()),
    });
  });
  afterAll(() => {
    upstream.stop(true);
  });

  test("forwards the counted stream, and answers 413 when it runs over", async () => {
    class Router extends ApiRouter {
      routes = {
        "/p": this.proxy(`http://127.0.0.1:${upstream.port}/`).middleware(`body-limit:${LIMIT}`),
      };
    }
    class AppKernel extends Kernel {
      config = {
        route: {
          api: { rootRouter: Router },
          view: {
            root: createRoot(() => createElement("div")),
            rootRouter: class extends ViewRouter {},
          },
        },
      };
    }
    const app = new App({ kernel: AppKernel });
    const send = (body: BodyInit) =>
      app.fetch(
        new Request("http://gemi.dev/api/p", {
          method: "POST",
          body,
          // @ts-expect-error not in the DOM lib's RequestInit
          duplex: "half",
        }),
      );
    vi.spyOn(console, "error").mockImplementation(() => {});
    let res = await send(chunked(under));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(under);
    res = await send(chunked(over));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(tooLarge);
    vi.restoreAllMocks();
  });
});
