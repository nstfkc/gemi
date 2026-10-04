import { createElement } from "react";
import { describe, expect, test } from "vitest";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import Api from "./__fixtures__/app/http/routes/api";
import { gemiRequestPlugin } from "./index";

/**
 * An app's routes, dispatched under vitest (#772).
 *
 * The fixture's controller and route take their request as a typed parameter,
 * which only works once the request-param rewrite has run on them. This
 * package's own `vitest.config.ts` installs `gemiRequestPlugin()`, the way an
 * app's does, so these requests going through is the proof that the plugin
 * applies the rewrite under vitest. Without it each one answers 500 with
 * `undefined is not an object (evaluating 'req.params')`.
 */

class TestKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: Api },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
}

const app = new App({ kernel: TestKernel });

describe("routes dispatched under vitest with gemiRequestPlugin", () => {
  test("a callback route reads its typed request", async () => {
    const res = await app.fetch(new Request("http://app.test/api/search?q=gemi"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ q: "gemi" });
  });

  test("a controller method reads its typed request", async () => {
    const res = await app.fetch(new Request("http://app.test/api/posts/p1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "p1" });
  });

  test("a custom request class is instantiated, and validates", async () => {
    const ok = await app.fetch(
      new Request("http://app.test/api/posts/p1/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Hello" }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: "p1", title: "Hello" });

    const invalid = await app.fetch(
      new Request("http://app.test/api/posts/p1/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(invalid.status).toBe(400);
  });
});

describe("gemiRequestPlugin", () => {
  const plugin = gemiRequestPlugin();
  const transform = plugin.transform as (code: string, id: string) => Promise<any>;
  const source = `
import type { HttpRequest } from "gemi/http";
import { Controller } from "gemi/http";
export class A extends Controller {
  async index(req: HttpRequest<{}, {}>) { return req.params; }
}
`;

  test("runs before Vite strips the type annotations", () => {
    expect(plugin.enforce).toBe("pre");
  });

  test("rewrites controllers and routes, also with a query on the id", async () => {
    for (const id of [
      "/app/http/controllers/A.ts",
      "/app/http/routes/api.tsx",
      "/app/http/controllers/A.ts?v=123",
    ]) {
      const out = await transform(source, id);
      expect(out.code).toContain("req = new HttpRequest()");
      expect(out.code).not.toContain("import type { HttpRequest }");
    }
  });

  test("leaves every other file alone", async () => {
    for (const id of [
      "/app/http/middleware/Auth.ts",
      "/app/views/Home.tsx",
      "/app/http/controllers/A.js",
      "/app/node_modules/pkg/http/routes/api.ts",
    ]) {
      expect(await transform(source, id)).toBeNull();
    }
  });
});
