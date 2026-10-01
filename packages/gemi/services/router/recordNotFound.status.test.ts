import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { RecordNotFoundError } from "../../orm/errors";

/**
 * An uncaught `RecordNotFoundError` answers 404, through a whole `App`.
 *
 * The route this is for is the ordinary one — a record looked up by an id taken
 * from the url:
 *
 * ```ts
 * "/pages/:pageId": this.get((req) =>
 *   Page.findUniqueOrThrow({ where: { publicId: req.params.pageId } })),
 * ```
 *
 * which answered **500** for an id that does not exist, because the HTTP layer
 * only gave a non-500 status to a `RequestBreakerError`.
 *
 * The errors here are thrown by hand rather than by a real query: what is under
 * test is the dispatcher's reaction to the error, and the ORM's own suites
 * already cover `*OrThrow` raising it (`orm/Model.ts` throws exactly this class
 * for the `ORTHROW` operations). The joint between the two — that the thrown
 * error satisfies the predicate — is pinned by `isRecordNotFoundError`'s unit
 * table in `orm/errors.test.ts`.
 */

const handled: string[] = [];
const failed: unknown[] = [];

class MissingRecordMiddleware extends Middleware {
  run() {
    throw new RecordNotFoundError("Membership", "findFirstOrThrow");
  }
}

/**
 * A global middleware resolving the request's tenant by an id from the url —
 * the shape that throws this before any route is chosen.
 */
let globalLooksUpRecord = false;

class TenantMiddleware extends Middleware {
  run() {
    if (globalLooksUpRecord) {
      throw new RecordNotFoundError("Workspace", "findUniqueOrThrow");
    }
  }
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/pages/:pageId": this.get(() => {
      handled.push("/pages/:pageId");
      throw new RecordNotFoundError("Page", "findUniqueOrThrow");
    }),
    // The same error thrown by a *second copy* of `gemi/orm`: right name, not
    // `instanceof` this module's class. Nothing about the response may differ.
    "/duplicated": this.get(() => {
      const error = new Error("No Page found (Page.findUniqueOrThrow).");
      error.name = "RecordNotFoundError";
      throw error;
    }),
    "/deleted": this.delete(() => {
      throw new RecordNotFoundError("Page", "delete");
    }),
    "/guarded": this.get(() => {
      handled.push("/guarded");
      return { ok: true };
    }).middleware(["missing"]),
    // The negative case: an ordinary throw is still the server's to answer.
    "/boom": this.get(() => {
      throw new Error("the floor gave way");
    }),
    // A message that reads exactly like the ORM's, under the wrong name. Only
    // the name and the class decide, so this one is still a 500.
    "/lookalike": this.get(() => {
      throw new Error("No Page found (Page.findUniqueOrThrow).");
    }),
    "/fine": this.get(() => ({ ok: true })),
  };
}

class AppKernel extends Kernel {
  config = {
    middleware: {
      aliases: { missing: MissingRecordMiddleware, tenant: TenantMiddleware },
      global: ["tenant"],
    },
    route: {
      api: {
        rootRouter: RootApiRouter,
        onRequestFail: (_req: HttpRequest, err: unknown) => {
          failed.push(err);
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

const get = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init)) as Promise<Response>;

beforeEach(() => {
  handled.length = 0;
  failed.length = 0;
  globalLooksUpRecord = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a RecordNotFoundError from an api handler", () => {
  test("answers 404 rather than 500", async () => {
    const res = await get("/api/pages/does-not-exist");
    expect(res.status).toBe(404);
  });

  test("answers the same body as any other not-found", async () => {
    const res = await get("/api/pages/does-not-exist");
    // Byte for byte what `FileNotFoundError` and an unmatched api route answer.
    expect(await res.json()).toEqual({ error: { kind: "not_found", message: "Not found", status: 404 } });
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  test("does not leak the model name or the operation", async () => {
    const res = await get("/api/pages/does-not-exist");
    const body = await res.text();
    // The error's own message is `No Page found (Page.findUniqueOrThrow).`,
    // which tells anyone who can guess a url what the schema is called.
    expect(body).not.toContain("Page");
    expect(body).not.toContain("findUniqueOrThrow");
  });

  test("is not cacheable, because creating the record changes the answer", async () => {
    const res = await get("/api/pages/does-not-exist");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("does not report the request as failed", async () => {
    // A route keyed on an id answers this for every stale link and every
    // crawler. Reporting them would bury the failures that are the server's.
    await get("/api/pages/does-not-exist");
    expect(failed).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("answers 404 for an error from a second copy of gemi/orm", async () => {
    // Matched by name, so `instanceof` being false across module copies cannot
    // send this back to a 500 — the reason `isPolicyDeniedError` matches names.
    const res = await get("/api/duplicated");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { kind: "not_found", message: "Not found", status: 404 } });
  });

  test("answers 404 for a write that matched no row", async () => {
    // `update` and `delete` raise it too, and a DELETE of something that is
    // not there is a 404 by the same reading as a GET of it.
    const res = await get("/api/deleted", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("a RecordNotFoundError from an api middleware", () => {
  test("answers 404 and never runs the handler", async () => {
    const res = await get("/api/guarded");
    expect(res.status).toBe(404);
    expect(handled).toEqual([]);
  });

  test("does not report the request as failed either", async () => {
    await get("/api/guarded");
    expect(failed).toEqual([]);
  });
});

describe("what is still the server's failure", () => {
  test("an ordinary throw is unaffected", async () => {
    // It leaves the dispatcher as a throw — the 500 is `server/`'s to build
    // (`unhandledError.ts`), which is exactly the path this change takes a
    // `RecordNotFoundError` off.
    await expect(get("/api/boom")).rejects.toThrow("the floor gave way");
    expect(failed).toHaveLength(1);
    expect((failed[0] as Error).message).toBe("the floor gave way");
  });

  test("an error merely mentioning a missing record is not a 404", async () => {
    // Guards the predicate against matching on the message, which would make
    // any app error quoting a failed lookup answer 404.
    await expect(get("/api/lookalike")).rejects.toThrow("No Page found");
    expect(failed).toHaveLength(1);
  });

  test("a route that finds its record is untouched", async () => {
    const res = await get("/api/fine");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("a RecordNotFoundError from a global middleware", () => {
  test("answers 404 on an api route", async () => {
    globalLooksUpRecord = true;
    const res = await get("/api/fine");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { kind: "not_found", message: "Not found", status: 404 } });
  });

  test("never reaches the route", async () => {
    globalLooksUpRecord = true;
    await get("/api/pages/anything");
    expect(handled).toEqual([]);
  });

  test("does not report the request as failed", async () => {
    globalLooksUpRecord = true;
    await get("/api/fine");
    expect(failed).toEqual([]);
  });

  test("leaves a request whose tenant exists alone", async () => {
    const res = await get("/api/fine");
    expect(res.status).toBe(200);
  });
});
