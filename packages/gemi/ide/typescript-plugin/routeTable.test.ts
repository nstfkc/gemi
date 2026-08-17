import { describe, expect, test } from "vitest";

import { createFixture, tableFor } from "./fixture";
import { createTestProject, type TestProject } from "./testProject";
import { buildRouteTable } from "./routeTable";
import type { RouteTarget } from "./types";

/**
 * Where a route jump lands.
 *
 * `rpcParity.test.ts` covers the other half — that the walker finds the same
 * *set* of routes the types do. This covers what each one points at, which is
 * the part a developer actually experiences: the difference between landing on
 * `reportsData()` and landing on the top of a 400-line router.
 */
function targetsFor(project: TestProject, path: string, verb = "GET"): RouteTarget[] {
  const table = tableFor(project);
  const entry = table.api.get(path)?.find((candidate) => candidate.verb === verb);
  if (!entry) throw new Error(`no ${verb} ${path} in table: ${[...table.api.keys()].join(", ")}`);
  return entry.targets;
}

/** The source text a target selects, plus where it selects it. */
function landing(project: TestProject, target: RouteTarget): string {
  const relative = target.fileName.replace(`${project.projectRoot}/`, "");
  return `${relative}:${project.locationOf(relative, target.span.start)} ${project.textAt(
    relative,
    target.span,
  )}`;
}

describe("API route targets", () => {
  const project = createFixture();

  test("a controller-backed route points at the method, not the class", () => {
    const [target] = targetsFor(project, "/home");
    expect(target.kind).toBe("controller-method");
    expect(target.containerName).toBe("HomeController");
    expect(target.name).toBe("index");
    expect(landing(project, target)).toBe("app/http/routes/api.ts:5:3 index");
  });

  test("a method inherited from a base controller resolves to the base", () => {
    // `ReportsController` declares nothing; `shared` is on its base. Resolving
    // through the instance type rather than the class body is what finds it.
    const [target] = targetsFor(project, "/reports");
    expect(target.kind).toBe("controller-method");
    expect(target.containerName).toBe("ReportsController");
    expect(landing(project, target)).toBe("app/http/routes/api.ts:10:3 shared");
  });

  test("an inline handler points at the callback", () => {
    const [target] = targetsFor(project, "/health");
    expect(target.kind).toBe("inline-handler");
    expect(project.textAt("app/http/routes/api.ts", target.span)).toBe("() => ({ ok: true })");
  });

  test("a middleware-wrapped route still finds its handler", () => {
    const [target] = targetsFor(project, "/guarded");
    expect(target.kind).toBe("inline-handler");
  });

  test("each resource verb points at its own controller method", () => {
    const collection = "/org/:orgId/products";
    const member = "/org/:orgId/products/:productId";
    const named = (path: string, verb: string) => {
      const [target] = targetsFor(project, path, verb);
      return `${target.containerName}.${target.name}`;
    };

    expect(named(collection, "GET")).toBe("ProductsController.list");
    expect(named(collection, "POST")).toBe("ProductsController.store");
    expect(named(member, "GET")).toBe("ProductsController.show");
    expect(named(member, "PUT")).toBe("ProductsController.update");
    expect(named(member, "DELETE")).toBe("ProductsController.delete");
  });

  test("a verb map resolves each verb separately", () => {
    expect(targetsFor(project, "/thing", "GET")[0].name).toBe("index");
    expect(targetsFor(project, "/thing", "POST")[0].name).toBe("archive");
  });

  test("a framework route points into the framework's own source", () => {
    const [target] = targetsFor(project, "/auth/me");
    expect(target.fileName).toMatch(/\/auth\/(routes|AuthController)\.ts$/);
  });
});

describe("view route targets", () => {
  const project = createFixture();

  test("a view offers its component and then its handler", () => {
    const table = tableFor(project);
    const [entry] = table.views.get("/org/:orgId/settings")!;
    expect(entry.targets.map((target) => target.kind)).toEqual([
      "view-component",
      "controller-method",
    ]);
    expect(entry.targets[0].fileName).toBe("/project/app/views/OrgSettings.tsx");
    expect(entry.targets[1].name).toBe("settings");
  });

  test("a view with no handler offers only its component", () => {
    const table = tableFor(project);
    const [entry] = table.views.get("/auth/sign-in")!;
    expect(entry.targets).toHaveLength(1);
    expect(entry.targets[0].fileName).toBe("/project/app/views/auth/SignIn.tsx");
  });

  test("a layout is indexed alongside the view sharing its path", () => {
    const table = tableFor(project);
    const kinds = table.views.get("/org/:orgId")!.map((entry) => entry.kind);
    expect(kinds.sort()).toEqual(["layout", "view"]);
  });
});

describe("shapes the walker cannot read through", () => {
  /**
   * The floor matters as much as the ceiling. A route built by a helper the
   * walker does not understand still has a `routes` entry, and landing on that
   * entry is a far better answer than landing nowhere — the developer is one
   * line from the handler either way.
   */
  const project = createTestProject({
    "app/http/routes/api.ts": `
import { ApiRouter } from "gemi/http";
declare function makeHandler(): any;
export default class Root extends ApiRouter {
  routes = {
    "/odd": makeHandler(),
    "/fine": this.get(() => ({ ok: true })),
  };
}
`,
    "gemi.d.ts": `
import type Api from "@/app/http/routes/api";
import type { CreateRPC } from "gemi/http";
declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
}
`,
  });

  test("an unrecognised handler shape is skipped rather than guessed at", () => {
    const table = tableFor(project);
    expect(table.api.has("/odd")).toBe(false);
    expect(table.api.has("/fine")).toBe(true);
  });

  test("a handler the walker cannot resolve falls back to the routes entry", () => {
    const fallback = createTestProject({
      "app/http/routes/api.ts": `
import { ApiRouter } from "gemi/http";
declare const Controller: any;
export default class Root extends ApiRouter {
  routes = {
    "/dynamic": this.get(Controller, someName()),
  };
}
declare function someName(): any;
`,
      "gemi.d.ts": `
import type Api from "@/app/http/routes/api";
import type { CreateRPC } from "gemi/http";
declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
}
`,
    });

    const [target] = buildRouteTable(fallback.ts, fallback.service.getProgram()!, {
      projectRoot: fallback.projectRoot,
      viewsDir: `${fallback.projectRoot}/app/views`,
      fileExists: fallback.fileExists,
    }).api.get("/dynamic")![0].targets;

    expect(target.kind).toBe("route-entry");
    expect(fallback.textAt("app/http/routes/api.ts", target.span)).toBe('"/dynamic"');
  });
});
