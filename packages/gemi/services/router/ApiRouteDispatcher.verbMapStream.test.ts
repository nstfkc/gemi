import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { Controller } from "../../http/Controller";
import { HttpRequest } from "../../http/HttpRequest";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * A stream route sharing its path with other verbs (#707): the path serves
 * its bytes on GET (and HEAD) and takes writes on the rest.
 */

const deleted: string[] = [];

class AssetController extends Controller {
  file() {
    const req = new HttpRequest<any, { fileId: string }>();
    return new Blob([`file ${req.params.fileId}`], { type: "text/plain" });
  }

  deleteFile() {
    const req = new HttpRequest<any, { fileId: string }>();
    deleted.push(req.params.fileId);
    return { deleted: req.params.fileId };
  }
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/files/:fileId": {
      get: this.stream(AssetController, "file"),
      delete: this.delete(AssetController, "deleteFile"),
    },
    "/notes/:noteId": {
      get: this.stream(async () => new Blob(["0123456789"])),
      patch: this.patch(async () => ({ patched: true })),
    },
    "/solo": this.stream(async () => new Blob(["0123456789"])),
    "/download": this.stream(async () => {
      // What `FileStorage.read()` hands back, decorated in place (#727).
      const read = {
        body: new Blob(["0123456789"], { type: "application/pdf" }),
        start: 0,
        end: 9,
        total: 10,
        partial: false,
        type: "application/pdf",
        name: "k3y",
      };
      return {
        ...read,
        name: "report.pdf",
        download: true,
        headers: { "Cache-Control": "private" },
      };
    }),
  };
}

class AppKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
}

const app = new App({ kernel: AppKernel });
const url = (path: string) => `http://gemi.dev/api${path}`;

describe("a verb map with a stream get", () => {
  test("GET streams the bytes", async () => {
    const res = await app.fetch(new Request(url("/files/abc")));

    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await res.text()).toBe("file abc");
  });

  test("GET honours Range", async () => {
    const res = await app.fetch(new Request(url("/notes/1"), { headers: { Range: "bytes=2-4" } }));

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(res.headers.get("Content-Length")).toBe("3");
    expect(await res.text()).toBe("234");
  });

  test("a standalone stream route sends only the window (#725)", async () => {
    const res = await app.fetch(new Request(url("/solo"), { headers: { Range: "bytes=2-4" } }));

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Length")).toBe("3");
    expect(await res.text()).toBe("234");
  });

  test("HEAD answers with the size and no body", async () => {
    const res = await app.fetch(new Request(url("/notes/1"), { method: "HEAD" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await res.text()).toBe("");
  });

  test("DELETE runs its own handler on the same path", async () => {
    deleted.length = 0;
    const res = await app.fetch(new Request(url("/files/abc"), { method: "DELETE" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "abc" });
    expect(deleted).toEqual(["abc"]);
  });

  test("PATCH runs its own handler on the same path", async () => {
    const res = await app.fetch(new Request(url("/notes/1"), { method: "PATCH" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ patched: true });
  });

  test("OPTIONS answers", async () => {
    const res = await app.fetch(new Request(url("/files/abc"), { method: "OPTIONS" }));

    expect(res.status).toBe(204);
  });
});

describe("a stream route's headers (#727)", () => {
  test("a decorated read keeps its headers on a 200", async () => {
    const res = await app.fetch(new Request(url("/download")));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Cache-Control")).toBe("private");
    expect(await res.text()).toBe("0123456789");
  });

  test("a decorated read keeps its headers on a 206", async () => {
    const res = await app.fetch(
      new Request(url("/download"), { headers: { Range: "bytes=2-4" } }),
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(res.headers.get("Content-Length")).toBe("3");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Cache-Control")).toBe("private");
    expect(await res.text()).toBe("234");
  });

  test("a plain stream route sends nosniff", async () => {
    const res = await app.fetch(new Request(url("/solo")));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
