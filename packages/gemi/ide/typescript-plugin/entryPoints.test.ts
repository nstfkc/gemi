import { describe, expect, test } from "vitest";

import { createFixture, GEMI_PATHS, LEGACY_GEMI_ENV, tableFor } from "./fixture";
import { lookupRoute } from "./lookup";
import type { RouteQuery } from "./callSite";
import { createTestProject, type TestProject } from "./testProject";

/**
 * How the plugin finds an application's routers, and what it says when it cannot.
 *
 * The default fixture already covers the shape a 0.56 app has — the package's
 * own `gemi.d.ts`, reached through `AppRPC<Api>` — so what is left here is the
 * shapes around it: an app that has not deleted its old `gemi.d.ts`, and an app
 * whose routers the augmentation cannot name at all. The second is the one worth
 * a test: `client/rpc.ts` mounts `/auth/*` in every gemi project, so a check for
 * "did we find anything" is always true, and a total failure to find the app's
 * own routers would otherwise go unmentioned.
 */
describe("router discovery", () => {
  test("a pre-0.56 gemi.d.ts alongside the package's does not double the table", () => {
    // Both declarations name the same `Api` and the same `View`, one through
    // `CreateRPC` and one through `AppRPC`. Two mounts of one router at one
    // prefix is one router.
    const project = createFixture({ "gemi.d.ts": LEGACY_GEMI_ENV });
    const table = tableFor(project);

    expect(table.diagnostics).toEqual([]);
    expect(table.api.get("/home")).toHaveLength(1);
    expect(table.api.get("/thing")).toHaveLength(2); // a GET and a POST, not four
    expect(table.views.get("/pricing")).toHaveLength(1);
  });

  test("an augmentation that only exists inside node_modules is still read", () => {
    // What an installed app looks like since 0.56: every file declaring `RPC` —
    // the package's own and the augmentation that extends it — is under
    // `node_modules`. A file walk cannot see them, and must not learn to: the
    // whole point of skipping that directory is to stay cheap. Asking the
    // checker for `gemi/client`'s exports has no such blind spot.
    //
    // The rest of the fixture cannot resolve this: the router is somewhere the
    // convention fallback does not look, so finding `/tucked-away` is proof the
    // node_modules declaration was read.
    const project = createTestProject(
      {
        "node_modules/gemi/client/index.d.ts": `
export interface RPC {}
export declare function useQuery<T extends keyof RPC>(url: T): unknown;
`,
        "node_modules/gemi/http/index.d.ts": `
export declare class ApiRouter { routes: any; get(...args: any[]): any; }
export type CreateRPC<T, P extends string = ""> = {};
`,
        "node_modules/gemi/gemi.d.ts": `
import type Api from "@/app/routers/api";
import type { CreateRPC } from "gemi/http";
declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
}
`,
        "app/routers/api.ts": `
import { ApiRouter } from "gemi/http";
export default class Root extends ApiRouter {
  routes = { "/tucked-away": this.get(() => ({ ok: true })) };
}
`,
        "app/views/Page.tsx": `
import { useQuery } from "gemi/client";
export default () => useQuery("/tucked-away");
`,
      },
      { paths: { "gemi/*": ["./node_modules/gemi/*"] } },
    );
    const table = tableFor(project);

    expect(table.api.has("/tucked-away")).toBe(true);
    expect(table.diagnostics).toEqual([]);
  });

  test("an augmentation that names none of the app's routers is reported and worked around", () => {
    // An app on a layout the augmentation's `@/app/*` import does not reach —
    // the case `AppRPC`'s `IsAny` guard exists for. The framework's own
    // `/auth/*` mounts still come through, which is exactly why they cannot be
    // taken as evidence that discovery worked.
    const project = createFixture({}, { paths: { ...GEMI_PATHS, "@/app/*": ["./elsewhere/*"] } });
    const table = tableFor(project);

    expect(table.diagnostics.join("\n")).toContain("names none of this project's routers");
    expect(table.api.has("/auth/me")).toBe(true);
    // ...and the convention fallback, which the diagnostic announces, rescues it.
    expect(table.api.has("/home")).toBe(true);
    expect(table.views.has("/pricing")).toBe(true);
  });
});

const SPREAD_ROUTER = `
import { ApiRouter, Controller } from "gemi/http";

class HomeController extends Controller {
  index() { return { ok: true }; }
  archive() { return { archived: true }; }
}

export default class Root extends ApiRouter {
  routes = {
    "/thing": {
      get: this.get(HomeController, "index"),
      post: this.post(HomeController, "archive"),
    },
    ...{ "/spread": this.get(HomeController, "index") },
  };
}
`;

/** `keyof GetRPC` as the checker resolves it — what a `useQuery` argument accepts. */
function getPathsFromTypes(project: TestProject): ReadonlySet<string> {
  const program = project.service.getProgram()!;
  const checker = program.getTypeChecker();
  const keys = program.getSourceFile("/project/keys.ts")!;

  for (const statement of keys.statements) {
    if (!project.ts.isTypeAliasDeclaration(statement) || statement.name.text !== "ApiKeys")
      continue;
    const type = checker.getTypeAtLocation(statement.name);
    const members = type.isUnion() ? type.types : [type];
    const paths = members
      .filter((member) => member.isStringLiteral())
      .map((member) => (member as { value: string }).value)
      .filter((key) => key.startsWith("GET:"))
      .map((key) => key.slice("GET:".length));
    if (paths.length === 0) throw new Error("keyof RPC did not resolve to string literals");
    return new Set(paths);
  }
  throw new Error("no ApiKeys alias in keys.ts");
}

describe("a routes entry the walk cannot read", () => {
  const project = createFixture({ "app/http/routes/api.ts": SPREAD_ROUTER });
  const table = tableFor(project);

  test("is named in the diagnostics rather than dropped in silence", () => {
    // `RouteParser` reads the declared type of `routes` and keeps the spread's
    // paths, so `/spread` autocompletes and has no row here. The tsserver log is
    // the only place that can say so.
    expect(getPathsFromTypes(project)).toContain("/spread");
    expect(table.api.has("/spread")).toBe(false);
    expect(table.api.has("/thing")).toBe(true);
    expect(table.diagnostics.join("\n")).toContain("spread");
  });

  test("does not disable verb narrowing at every other call site", () => {
    // The hole is one path; the damage used to be the whole project. `keyof
    // GetRPC` holds `/spread` and the table does not, so testing one against
    // the other wholesale failed for every verb at once — and `useQuery("/thing")`
    // started offering its POST handler, a symptom nowhere near its cause.
    const query = { path: "/thing", allowedPaths: getPathsFromTypes(project) } as RouteQuery;

    const verbs = lookupRoute(table, query).map((match) =>
      match.candidate.kind === "api" ? match.candidate.entry.verb : match.candidate.kind,
    );
    expect(verbs).toEqual(["GET"]);
  });
});
