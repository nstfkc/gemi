import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { AgentController } from "../ai/AgentController";
import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { MiddlewareRegistry } from "../services/middleware/MiddlewareRegistry";
import { createFlatApiRoutes } from "../services/router/createFlatApiRoutes";
import { ApiRouter } from "./ApiRouter";
import { bodyLimitOf } from "./bodyLimit";
import { HttpRequest } from "./HttpRequest";
import { middlewareConfigDefaults, type MiddlewareConfig } from "./middleware-config";
import { uploadBytesOf } from "./validate";
import { ViewRouter } from "./ViewRouter";

/** The default request body limit and the upload defaults (#1196). */

const MB = 1024 * 1024;

/** In-process, a Request does not get a Content-Length; a client's does. */
const declared = (bytes: number) => ({ "Content-Length": String(bytes) });

/** A body with no length, as a chunked upload sends it. */
function chunked(size: number, chunkSize = 64 * 1024) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, size - sent);
      controller.enqueue(new Uint8Array(n).fill(97));
      sent += n;
    },
  });
}

function multipart(fields: Record<string, Blob | string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

class AvatarRequest extends HttpRequest<any, any> {
  schema = {
    avatar: { file: "Pick a file.", "fileSize:1KB": "At most 1 KB." },
  };
}

class AttachmentRequest extends HttpRequest<any, any> {
  schema = { document: { file: "Pick a file." } };
}

class BigFilesRequest extends HttpRequest<any, any> {
  schema = {
    first: { "fileSize:3KB": "At most 3 KB." },
    second: { "fileSize:3KB": "At most 3 KB." },
  };
}

class TitleRequest extends HttpRequest<any, any> {
  schema = { title: { string: "A title." } };
}

const sizeOf = async (Req: new () => HttpRequest<any, any>) => {
  const input = (await new Req().input()).toJSON() as Record<string, unknown>;
  const sizes: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value instanceof Blob) sizes[key] = value.size;
  }
  return sizes;
};

class RootApiRouter extends ApiRouter {
  routes = {
    "/raw": this.post(async () => {
      const bytes = await new HttpRequest<any, any>().rawRequest.arrayBuffer();
      return { size: bytes.byteLength };
    }),
    "/raw-upload": this.post(async () => {
      const bytes = await new HttpRequest<any, any>().rawRequest.arrayBuffer();
      return { size: bytes.byteLength };
    }).middleware("body-limit:upload"),
    "/avatar": this.post(() => sizeOf(AvatarRequest)),
    "/attachment": this.post(() => sizeOf(AttachmentRequest)),
    "/attachment-capped": this.post(() => sizeOf(AttachmentRequest)).middleware("body-limit:128b"),
    "/big-files": this.post(() => sizeOf(BigFilesRequest)),
    "/title": this.post(() => sizeOf(TitleRequest)),
  };
}

function makeApp(middleware?: MiddlewareConfig) {
  class AppKernel extends Kernel {
    config = {
      ...(middleware ? { middleware } : {}),
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
}

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
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the default", () => {
  test("is 1 MiB, with 50 MiB for uploads", () => {
    expect(middlewareConfigDefaults()).toMatchObject({ bodyLimit: "1mb", uploadBodyLimit: "50mb" });
    const registry = new MiddlewareRegistry(middlewareConfigDefaults());
    expect(registry.defaultBodyLimit).toBe(MB);
    expect(registry.uploadBodyLimit).toBe(50 * MB);
  });

  const app = makeApp();

  test("an app without middleware config refuses a body over 1 MiB, declared or chunked", async () => {
    let res = await send(app, "/raw", new Uint8Array(MB + 1), declared(MB + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: { kind: "form_error", message: "The request body is too large.", status: 413 },
    });
    res = await send(app, "/raw", chunked(MB + 1));
    expect(res.status).toBe(413);
  });

  test("a body of 1 MiB gets through", async () => {
    const res = await send(app, "/raw", chunked(MB));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: MB });
  });

  test.each([[null], ["none"]])("bodyLimit: %j turns it off", async (bodyLimit) => {
    const off = makeApp({ bodyLimit });
    const res = await send(off, "/raw", chunked(2 * MB));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 2 * MB });
  });
});

describe("upload routes", () => {
  const app = makeApp({ bodyLimit: "128b", uploadBodyLimit: "4kb" });
  const file = (bytes: number) => new File([new Uint8Array(bytes)], "f.bin");

  test("body-limit:upload is the app's uploadBodyLimit", async () => {
    let res = await send(app, "/raw-upload", chunked(4096));
    expect(res.status).toBe(200);
    res = await send(app, "/raw-upload", chunked(4097));
    expect(res.status).toBe(413);
    // A declared length over it is refused before the handler runs.
    res = await send(app, "/raw-upload", new Uint8Array(4097), declared(4097));
    expect(res.status).toBe(413);
    // The plain default still applies elsewhere.
    res = await send(app, "/raw", chunked(129));
    expect(res.status).toBe(413);
  });

  test("a multipart body whose schema has a file rule gets the upload default", async () => {
    const res = await send(app, "/attachment", multipart({ document: file(3000) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ document: 3000 });
    const tooBig = await send(app, "/attachment", multipart({ document: file(5000) }));
    expect(tooBig.status).toBe(413);
  });

  test("a file over its fileSize rule but within the body limit is a validation error, not a 413", async () => {
    const res = await send(app, "/avatar", multipart({ avatar: file(2048) }));
    expect(res.status).not.toBe(413);
    expect(JSON.stringify(await res.json())).toContain("At most 1 KB.");
    const ok = await send(app, "/avatar", multipart({ avatar: file(1024) }));
    expect(await ok.json()).toEqual({ avatar: 1024 });
  });

  test("fileSize ceilings above uploadBodyLimit raise the limit to their sum plus bodyLimit", async () => {
    // 2 × 3 KiB = 6 KiB of files, over the 4 KiB upload default; the 1 KiB
    // bodyLimit on top is room for the parts' headers.
    const roomy = makeApp({ bodyLimit: "1kb", uploadBodyLimit: "4kb" });
    let res = await send(roomy, "/big-files", multipart({ first: file(3072), second: file(3072) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ first: 3072, second: 3072 });
    // Past the sum plus bodyLimit is still a 413.
    res = await send(roomy, "/big-files", multipart({ first: file(3072), second: file(3072), extra: "a".repeat(2048) }));
    expect(res.status).toBe(413);
  });

  test("a schema without file rules keeps the default", async () => {
    const res = await send(app, "/title", multipart({ title: "a".repeat(1024) }));
    expect(res.status).toBe(413);
  });

  test("a route's own body-limit wins over the upload default", async () => {
    const res = await send(app, "/attachment-capped", multipart({ document: file(1024) }));
    expect(res.status).toBe(413);
  });

  test("with bodyLimit off, uploads are not limited either", async () => {
    const off = makeApp({ bodyLimit: null, uploadBodyLimit: "4kb" });
    const res = await send(off, "/attachment", multipart({ document: file(8192) }));
    expect(res.status).toBe(200);
  });
});

describe("agent routes", () => {
  class ChatController extends AgentController {
    agent = { name: "stub", tools: [], provider: {} } as any;
  }
  const routes = createFlatApiRoutes({
    "/chat": new (class extends ApiRouter {
      routes = { "/": this.agent(ChatController) };
    })().routes["/"] as any,
  });

  test("stream bounds its own body, upload takes the upload default", () => {
    expect(routes["/chat"].POST.bodyLimitDefault).toBe("none");
    expect(routes["/chat/files"].POST.bodyLimitDefault).toBe("upload");
    expect(routes["/chat/attach"].POST.bodyLimitDefault).toBeUndefined();
  });

  test("the registry installs what the route asks for", () => {
    const registry = new MiddlewareRegistry({
      ...middlewareConfigDefaults(),
      bodyLimit: "1mb",
      uploadBodyLimit: "20mb",
    });
    const post = () => new Request("http://gemi.dev/api/chat", { method: "POST", body: "{}" });

    let req = post();
    registry.applyDefaultBodyLimit(req);
    expect(bodyLimitOf(req)).toBe(MB);
    req = post();
    registry.applyDefaultBodyLimit(req, "upload");
    expect(bodyLimitOf(req)).toBe(20 * MB);
    req = post();
    registry.applyDefaultBodyLimit(req, "none");
    expect(bodyLimitOf(req)).toBeNull();
  });
});

describe("uploadBytesOf", () => {
  test("null without file rules, the fileSize sum with them", () => {
    expect(uploadBytesOf({ title: { string: "x", "max:3": "y" } })).toBeNull();
    expect(uploadBytesOf({ doc: { file: "x" } })).toBe(0);
    expect(uploadBytesOf({ doc: { "fileType:pdf": "x" } })).toBe(0);
    expect(uploadBytesOf({ a: { "fileSize:2MB": "x" }, b: { file: "y", "fileSize:1KB": "z" } })).toBe(
      2 * MB + 1024,
    );
  });
});
