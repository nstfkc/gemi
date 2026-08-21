import type ts from "typescript";
import { describe, expect, test } from "vitest";

import { createFixture } from "./fixture";
import { decorateLanguageService } from "./plugin";
import type { TestProject } from "./testProject";

/**
 * The plugin as an editor sees it: a position in a file, a list of places to go.
 *
 * These go through `decorateLanguageService` rather than the pieces underneath,
 * because the contract that matters is the language service one — the right span
 * underlined, the right definitions returned, and everything that is not a route
 * handed straight back to TypeScript.
 */
const PAGE_FILE = "app/views/Page.tsx";

const PAGE = `
import { useQuery, useMutation, useMutate } from "gemi/client";
import { Link, Form } from "gemi/client";

const table = { "/home": 1 };

export default function Page() {
  useQuery("/home");
  useQuery("/thing");
  useQuery("/org/:orgId/products");
  useQuery("/auth/me");
  useMutation("POST", "/thing");
  const mutate = useMutate();
  mutate({ path: "/reports" });
  mutate({ path: "/thing" });
  mutate({ path: "/org/:orgId" });
  const loose = "/reports";
  const read = table["/home"];
  return (
    <>
      <Link href="/pricing">pricing</Link>
      <Form action="/thing" method="POST" />
      <Form action="/thing" onSuccess={() => {}} />
    </>
  );
}
`;

interface Harness {
  project: TestProject;
  service: ts.LanguageService;
  logs: string[];
  /** Definitions for `quoted` inside the unique snippet `marker`, as `file name`. */
  definitionsAt(marker: string, quoted?: string): string[];
  quickInfoAt(marker: string, quoted?: string): string;
  boundTextAt(marker: string, quoted?: string): string | undefined;
  positionOf(marker: string, offsetInMarker: number): number;
  rebuildCount(): number;
}

function createHarness(): Harness {
  const project = createFixture({ [PAGE_FILE]: PAGE });
  const logs: string[] = [];
  const service = decorateLanguageService({
    ts: project.ts,
    languageService: project.service,
    projectRoot: project.projectRoot,
    viewsDir: `${project.projectRoot}/app/views`,
    fileExists: project.fileExists,
    getScriptVersion: project.getScriptVersion,
    log: (message) => logs.push(message),
  });

  /** Just inside the opening quote of `quoted`, which must sit inside `marker`. */
  const inside = (marker: string, quoted: string) => {
    const at = marker.indexOf(quoted);
    if (at === -1) throw new Error(`${JSON.stringify(quoted)} is not in ${JSON.stringify(marker)}`);
    return project.offsetOf(PAGE_FILE, marker) + at + 1;
  };

  const definitions = (position: number) =>
    service.getDefinitionAndBoundSpan(`/project/${PAGE_FILE}`, position);

  return {
    project,
    service,
    logs,
    positionOf: (marker, offsetInMarker) => project.offsetOf(PAGE_FILE, marker) + offsetInMarker,
    definitionsAt(marker, quoted = firstQuoted(marker)) {
      return (definitions(inside(marker, quoted))?.definitions ?? []).map((definition) => {
        const relative = definition.fileName.replace(`${project.projectRoot}/`, "");
        return `${relative} ${definition.name}`;
      });
    },
    quickInfoAt(marker, quoted = firstQuoted(marker)) {
      const info = service.getQuickInfoAtPosition(`/project/${PAGE_FILE}`, inside(marker, quoted));
      return (info?.documentation ?? []).map((part) => part.text).join("\n");
    },
    boundTextAt(marker, quoted = firstQuoted(marker)) {
      const result = definitions(inside(marker, quoted));
      return result && project.textAt(PAGE_FILE, result.textSpan);
    },
    rebuildCount: () => logs.filter((line) => line.startsWith("built route table")).length,
  };
}

/** The first `"…"` in a snippet, which is the path in every marker but one. */
function firstQuoted(marker: string): string {
  const match = /"[^"]*"/.exec(marker);
  if (!match) throw new Error(`no quoted string in ${JSON.stringify(marker)}`);
  return match[0];
}

describe("go to definition on an API route", () => {
  const harness = createHarness();

  test("a useQuery path resolves to the controller method behind it", () => {
    expect(harness.definitionsAt('useQuery("/home")')).toEqual(["app/http/routes/api.ts index"]);
  });

  test("the underlined span is the path, without its quotes", () => {
    expect(harness.boundTextAt('useQuery("/home")')).toBe("/home");
  });

  test("useQuery picks the GET handler where a path carries several verbs", () => {
    // `/thing` has both a GET and a POST. Nothing in the call names a verb; the
    // parameter's constraint is the GET route set, and that is what separates
    // them.
    expect(harness.definitionsAt('useQuery("/thing")')).toEqual(["app/http/routes/api.ts index"]);
  });

  test("useMutation picks the handler for the verb it was given", () => {
    expect(harness.definitionsAt('useMutation("POST", "/thing")', '"/thing"')).toEqual([
      "app/http/routes/api.ts archive",
    ]);
  });

  test("a route reached through a nested router and a resource resolves", () => {
    expect(harness.definitionsAt('useQuery("/org/:orgId/products")')).toEqual([
      "app/http/routes/api.ts list",
    ]);
  });

  test("a framework route resolves into the framework's own source", () => {
    const [definition] = harness.definitionsAt('useQuery("/auth/me")');
    expect(definition).toContain("/auth/");
  });

  test("a path given to a hook that returns a function resolves too", () => {
    // The callee is the *result* of a call, and the constraint still comes
    // through the resolved signature.
    expect(harness.definitionsAt('mutate({ path: "/reports" })')).toEqual([
      "app/http/routes/api.ts shared",
    ]);
  });

  test("a path held in an options object narrows the same way an argument does", () => {
    // `mutate({ path, params?, search? })` is the real `useMutate` signature —
    // the path is a property, not an argument. Its `T extends keyof GetRPC` is
    // the same constraint every other hook carries, so `/thing`'s POST handler
    // has to be ruled out here exactly as it is for `useQuery`.
    expect(harness.definitionsAt('mutate({ path: "/thing" })')).toEqual([
      "app/http/routes/api.ts index",
    ]);
  });

  test("an options-object path cannot mean a view route", () => {
    // `/org/:orgId` is a layout, a view and a GET endpoint. `keyof GetRPC`
    // admits only the last, so the two view components are not offered.
    expect(harness.definitionsAt('mutate({ path: "/org/:orgId" })')).toEqual([
      "app/http/routes/api.ts index",
    ]);
  });

  test("the older getDefinitionAtPosition entry point answers the same way", () => {
    // Some clients — Neovim's built-in LSP among them — reach tsserver's
    // `definition` command, which lands here rather than on the bound-span
    // variant. Both have to answer or the feature works in some editors only.
    const definitions = harness.service.getDefinitionAtPosition(
      `/project/${PAGE_FILE}`,
      harness.positionOf('useQuery("/home")', 11),
    );
    expect(definitions?.map((definition) => definition.name)).toEqual(["index"]);
  });

  test("a route path held in a variable resolves as well", () => {
    // No call to take a constraint from, so every verb at the path is offered.
    // One handler serves `/reports`, so there is still only one answer.
    expect(harness.definitionsAt('const loose = "/reports"')).toEqual([
      "app/http/routes/api.ts shared",
    ]);
  });
});

describe("go to definition on a view route", () => {
  const harness = createHarness();

  test("a Link href resolves to the view component", () => {
    expect(harness.definitionsAt('<Link href="/pricing">')).toEqual([
      "app/views/Pricing.tsx Pricing",
    ]);
  });

  test("a Form action resolves to the handler for its method", () => {
    expect(harness.definitionsAt('<Form action="/thing" method="POST" />', '"/thing"')).toEqual([
      "app/http/routes/api.ts archive",
    ]);
  });

  test("a Form with no method still resolves to POST, not GET", () => {
    // `method` defaults to `"POST"` in the component, so an omitted attribute
    // is not an absent verb. `/thing` carries both a GET and a POST, which is
    // the only shape where getting this wrong is visible.
    expect(
      harness.definitionsAt('<Form action="/thing" onSuccess={() => {}} />', '"/thing"'),
    ).toEqual(["app/http/routes/api.ts archive"]);
  });
});

describe("what the plugin leaves to TypeScript", () => {
  const harness = createHarness();

  test("an import specifier still goes to the module", () => {
    const result = harness.service.getDefinitionAndBoundSpan(
      `/project/${PAGE_FILE}`,
      harness.positionOf('"gemi/client";\nimport { Link', 3),
    );
    expect(result?.definitions?.[0]?.fileName).toContain("/client/index.ts");
  });

  test("an object key that looks like a route is not hijacked", () => {
    const result = harness.service.getDefinitionAndBoundSpan(
      `/project/${PAGE_FILE}`,
      harness.positionOf('const table = { "/home": 1 }', 18),
    );
    // TypeScript's own answer: the property, in this file.
    expect(result?.definitions?.[0]?.kind).toBe("property");
    expect(result?.definitions?.[0]?.fileName).toContain(PAGE_FILE);
  });

  test("an element access resolves to the property, not the route", () => {
    const result = harness.service.getDefinitionAndBoundSpan(
      `/project/${PAGE_FILE}`,
      harness.positionOf('table["/home"]', 7),
    );
    expect(result?.definitions?.[0]?.fileName).toContain(PAGE_FILE);
  });

  test("an identifier is resolved by TypeScript as usual", () => {
    const result = harness.service.getDefinitionAndBoundSpan(
      `/project/${PAGE_FILE}`,
      harness.positionOf('useQuery("/home")', 2),
    );
    expect(result?.definitions?.[0]?.name).toBe("useQuery");
  });
});

describe("hover", () => {
  const harness = createHarness();

  test("names the route and where its handler lives", () => {
    const documentation = harness.quickInfoAt('useQuery("/home")');
    expect(documentation).toContain("GET /home");
    expect(documentation).toContain("HomeController.index()");
    expect(documentation).toContain("app/http/routes/api.ts:5");
  });

  test("leads with the route, since TypeScript says nothing about a path literal", () => {
    const info = harness.service.getQuickInfoAtPosition(
      `/project/${PAGE_FILE}`,
      harness.positionOf('useQuery("/home")', 11),
    );
    expect(info?.displayParts?.map((part) => part.text).join("")).toBe("GET /home");
  });

  test("hovering anything else is TypeScript's answer, untouched", () => {
    const info = harness.service.getQuickInfoAtPosition(
      `/project/${PAGE_FILE}`,
      harness.positionOf('useQuery("/home")', 2),
    );
    expect(info?.displayParts?.map((part) => part.text).join("")).toContain("useQuery");
    expect(info?.documentation?.map((part) => part.text).join("")).not.toContain("GET /home");
  });
});

describe("keeping up with edits", () => {
  test("a rebuilt router changes where the jump lands", () => {
    const harness = createHarness();
    expect(harness.definitionsAt('useQuery("/home")')).toEqual(["app/http/routes/api.ts index"]);

    const api = "/project/app/http/routes/api.ts";
    const source = harness.project.service.getProgram()!.getSourceFile(api)!.text;
    harness.project.update(
      api,
      source.replace(
        '"/home": this.get(HomeController, "index")',
        '"/home": this.get(HomeController, "archive")',
      ),
    );

    expect(harness.definitionsAt('useQuery("/home")')).toEqual(["app/http/routes/api.ts archive"]);
  });

  test("an edit to a file the table never read reuses it", () => {
    const harness = createHarness();
    harness.definitionsAt('useQuery("/home")');
    expect(harness.rebuildCount()).toBe(1);

    // Editing the page the query is written on must not rebuild the router
    // index — that is the difference between one walk and one per keystroke.
    harness.project.update(`/project/${PAGE_FILE}`, `${PAGE}\n// typing in the component`);
    harness.definitionsAt('useQuery("/home")');
    harness.definitionsAt('useQuery("/thing")');

    expect(harness.rebuildCount()).toBe(1);
  });

  test("a new file in the project is noticed", () => {
    const harness = createHarness();
    harness.definitionsAt('useQuery("/home")');
    const before = harness.rebuildCount();

    harness.project.update("/project/added.ts", "export const added = 1;");
    harness.definitionsAt('useQuery("/home")');

    expect(harness.rebuildCount()).toBe(before + 1);
  });
});
