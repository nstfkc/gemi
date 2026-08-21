import type ts from "typescript";
import { dirname, join } from "node:path";

import { buildRouteTable } from "./routeTable";
import { createTestProject, type TestProject } from "./testProject";
import type { RouteTable } from "./types";

/**
 * A gemi app, in memory, wired to the real framework.
 *
 * The fixture app declares every route shape the walker understands —
 * controller-backed and inline handlers, an inherited controller method, a
 * nested router, a resource, a verb map, a route group, `file`/`stream`, views
 * under a layout — so a test that walks it exercises all of them, and
 * `rpcParity.test.ts` can hold the whole set against `keyof RPC`.
 *
 * `paths` maps `gemi/*` at the package source rather than a stand-in, which is
 * what makes that comparison mean anything. React does not resolve inside the
 * harness, so the fixture has type errors — none of them in the route types,
 * which is all any of this reads.
 */
const GEMI_ROOT = dirname(dirname(import.meta.dirname));

const API_ROUTER = `
import { ApiRouter, Controller, ResourceController } from "gemi/http";

class HomeController extends Controller {
  index() { return { ok: true }; }
  archive() { return { archived: true }; }
}

class BaseReportsController extends Controller {
  shared() { return { shared: 1 }; }
}

// Inherits \`shared\` — the walker has to resolve through the base class the way
// the checker does.
class ReportsController extends BaseReportsController {}

class ProductsController extends ResourceController {
  async list() { return { items: [] as number[] }; }
  async show() { return { item: 1 }; }
  async store() { return { id: 1 }; }
  async update() { return { id: 1 }; }
  async delete() { return { ok: true }; }
}

class OrgRouter extends ApiRouter {
  routes = {
    "/": this.get(HomeController, "index"),
    "/products/:productId": this.resource(ProductsController),
  };
}

export default class Root extends ApiRouter {
  routes = {
    "/health": this.get(() => ({ ok: true })),
    "/home": this.get(HomeController, "index"),
    "/home/archive": this.delete(HomeController, "archive"),
    "/reports": this.get(ReportsController, "shared"),
    "/guarded": this.get(() => ({ g: 1 })).middleware(["auth"]),
    "/replaced": this.put(() => ({ id: 1 })),
    "/patched": this.patch(() => ({ p: true })),
    "/thing": {
      get: this.get(HomeController, "index"),
      post: this.post(HomeController, "archive"),
    },
    "/org/:orgId": OrgRouter,
    "/(group)/grouped": this.get(() => ({ grouped: true })),
    "/download": this.file(() => null),
    "/video": this.stream(() => null),
  };
}
`;

const VIEW_ROUTER = `
import { Controller, ViewRouter } from "gemi/http";

class PageController extends Controller {
  overview() { return { a: 1 }; }
  settings() { return { b: 2 }; }
}

class AuthRouter extends ViewRouter {
  routes = {
    "/sign-in": this.view("auth/SignIn"),
  };
}

export default class RootView extends ViewRouter {
  routes = {
    "/": this.view("Home", [PageController, "overview"]),
    "/auth": AuthRouter,
    "/org/:orgId": this.layout("OrgLayout", [PageController, "overview"], {
      "/": this.view("OrgOverview"),
      "/settings": this.view("OrgSettings", [PageController, "settings"]),
    }),
    "/(marketing)/pricing": this.view("Pricing"),
  };
}
`;

/**
 * The augmentation an app carried before 0.56, when `gemi.d.ts` lived at its root.
 *
 * Not part of the fixture: since 0.56 the package ships the augmentation itself,
 * and `paths` above maps `gemi/*` at the package source, so the fixture app is
 * already wired the way a `bun add gemi` app is — through
 * `packages/gemi/gemi.d.ts`, whose `AppRPC<Api>` resolves `@/app/*` against this
 * project. Tests that need the old shape, or a second declaration alongside the
 * package's, pass this in explicitly.
 */
export const LEGACY_GEMI_ENV = `
import type Api from "@/app/http/routes/api";
import type View from "@/app/http/routes/view";
import type { CreateRPC, CreateViewRPC } from "gemi/http";

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
  export interface ViewRPC extends CreateViewRPC<View> {}
}
`;

const KEYS = `
import type { RPC, ViewRPC } from "gemi/client";
export type ApiKeys = keyof RPC;
export type ViewKeys = keyof ViewRPC;
`;

/** Maps `gemi/*` at the package source, so the fixture compiles against the real types. */
export const GEMI_PATHS = { "gemi/*": [join(GEMI_ROOT, "*")] };

export function createFixture(
  extraFiles: Record<string, string> = {},
  extraCompilerOptions: ts.CompilerOptions = {},
): TestProject {
  return createTestProject(
    {
      "app/http/routes/api.ts": API_ROUTER,
      "app/http/routes/view.ts": VIEW_ROUTER,
      "app/views/Home.tsx": "export default function Home() { return null; }",
      "app/views/Pricing.tsx": "export default function Pricing() { return null; }",
      "app/views/OrgLayout.tsx": "export default function OrgLayout() { return null; }",
      "app/views/OrgOverview.tsx": "export default function OrgOverview() { return null; }",
      "app/views/OrgSettings.tsx": "export default function OrgSettings() { return null; }",
      "app/views/auth/SignIn.tsx": "export default function SignIn() { return null; }",
      "keys.ts": KEYS,
      ...extraFiles,
    },
    { paths: GEMI_PATHS, ...extraCompilerOptions },
  );
}

export function tableFor(project: TestProject): RouteTable {
  return buildRouteTable(project.ts, project.service.getProgram()!, {
    projectRoot: project.projectRoot,
    viewsDir: `${project.projectRoot}/app/views`,
    fileExists: project.fileExists,
  });
}
