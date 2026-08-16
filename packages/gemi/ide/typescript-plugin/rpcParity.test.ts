import * as ts from "typescript";
import { describe, expect, test } from "vitest";

import { createFixture, tableFor } from "./fixture";
import type { TestProject } from "./testProject";

/**
 * The walk in `routeTable.ts`, checked against the types it exists to mirror.
 *
 * A lookup only works if the plugin's idea of a route key is character-identical
 * to `CreateRPC`'s, because the string being looked up was typed by a developer
 * whose autocomplete came from `CreateRPC`. Nothing enforces that agreement: the
 * two live in different files, in different languages — one a template literal
 * type, the other a `.slice()` — and a change to either is invisible to the
 * other.
 *
 * So this test asserts no list of expected keys. It asks the checker for
 * `keyof RPC` — the very type an app's `useQuery` call is constrained to — and
 * requires the walker's key set to equal it. A route shape added to `ApiRouter`
 * fails here until the walker learns it; a path rule that changes in either
 * place fails here until it changes in both.
 */

/** The members of a `type X = …` union alias, as the checker resolves it. */
function unionMembers(project: TestProject, fileName: string, aliasName: string): string[] {
  const program = project.service.getProgram()!;
  const sourceFile = program.getSourceFile(`/project/${fileName}`);
  if (!sourceFile) throw new Error(`fixture ${fileName} is not in the program`);
  const checker = program.getTypeChecker();

  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== aliasName) continue;
    const type = checker.getTypeAtLocation(statement.name);
    const members = type.isUnion() ? type.types : [type];
    const keys = members.map((member) =>
      member.isStringLiteral() ? member.value : checker.typeToString(member),
    );
    // A fixture that failed to typecheck resolves to `never`/`any`, which would
    // make an equality assertion pass against an empty set.
    if (keys.length === 0 || keys.some((key) => key === "never" || key === "any")) {
      throw new Error(`${aliasName} did not resolve to string literals: ${keys.join(", ")}`);
    }
    return keys.sort();
  }
  throw new Error(`no type alias ${aliasName} in ${fileName}`);
}

describe("the route table against the RPC types", () => {
  const project = createFixture();
  const table = tableFor(project);

  test("reaches the app's routers through the gemi.d.ts augmentation", () => {
    expect(table.diagnostics).toEqual([]);
    expect(table.dependencies).toContain("/project/gemi.d.ts");
    expect(table.dependencies).toContain("/project/app/http/routes/api.ts");
    expect(table.dependencies).toContain("/project/app/http/routes/view.ts");
  });

  test("indexes exactly the API routes RPC exposes", () => {
    const fromTypes = unionMembers(project, "keys.ts", "ApiKeys");
    const fromWalk = [...table.api.values()]
      .flat()
      .filter((entry) => entry.inRpc)
      .map((entry) => `${entry.verb}:${entry.path}`)
      .sort();

    expect(fromWalk).toEqual(fromTypes);

    // Not a vacuous pass: the fixture declares every route shape the walker
    // handles, and both sides have to reach all of them.
    expect(fromTypes).toContain("GET:/org/:orgId/products");
    expect(fromTypes).toContain("DELETE:/org/:orgId/products/:productId");
    expect(fromTypes).toContain("GET:/grouped");
    expect(fromTypes).toContain("POST:/thing");
    expect(fromTypes.length).toBeGreaterThanOrEqual(16);
  });

  test("indexes the framework's own routes, at the prefix RPC mounts them under", () => {
    // `client/rpc.ts` declares `RPC extends CreateRPC<AuthApiRouter, "/auth">`,
    // so `useQuery("/auth/me")` typechecks in every gemi app. Discovery driven
    // by the app's route config would find the app's routers and miss these.
    const authPaths = [...table.api.keys()].filter((path) => path.startsWith("/auth/"));
    expect(authPaths.length).toBeGreaterThan(0);

    const target = table.api.get("/auth/me")?.[0]?.targets[0];
    expect(target?.fileName).toContain("/auth/");
  });

  test("indexes exactly the view routes ViewRPC exposes", () => {
    const fromTypes = unionMembers(project, "keys.ts", "ViewKeys");
    const fromWalk = [...table.views.values()]
      .flat()
      .filter((entry) => entry.inRpc)
      .map((entry) => `${entry.kind}:${entry.path}`)
      .sort();

    expect(fromWalk).toEqual(fromTypes);
    expect(fromTypes).toContain("view:/auth/sign-in");
    expect(fromTypes).toContain("layout:/org/:orgId");
    expect(fromTypes).toContain("view:/pricing");
  });

  test("indexes the file and stream routes RPC drops, marked as such", () => {
    const excluded = [...table.api.values()]
      .flat()
      .filter((entry) => !entry.inRpc)
      .map((entry) => `${entry.verb}:${entry.path}`)
      .sort();

    expect(excluded).toEqual(["GET:/download", "GET:/video"]);
  });
});
