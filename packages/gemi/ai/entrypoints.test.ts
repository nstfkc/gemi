import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The two entries of `gemi/ai`, and the wall between them.
 *
 * `gemi/ai/client` exports `useChat` and `gemi/ai` exports everything else,
 * for one reason: `gemi/ai` reaches the providers (which read
 * `OPENAI_API_KEY` and `AZURE_OPENAI_API_KEY` from the environment), the tool
 * registry (which closes over every `execute` an app wrote, database handles
 * and all) and `signing.ts` (which reads `process.env.SECRET` — the value that,
 * disclosed, lets a client forge its own approvals).
 *
 * A barrel is evaluated, not browsed. One `export { useChat }` added to
 * `ai/index.ts` by someone tidying two files into one would put all of that in
 * the import graph of every component that chats, and nothing would say so:
 * the app still builds, the tests still pass, and a bundler *might* shake it
 * out — a dev server, a test runner and a misconfigured build will not, and
 * the failure is silent. So the invariant is checked here rather than trusted.
 *
 * This walks the *static, eager* graph, the same way `barrel-imports.test.ts`
 * does and for the same reason: `import type` is elided by the transpiler, so
 * `useChat`'s type-only reach into `AgentMessage` and `RPC` is correctly not a
 * cost, while a value import of the same module is.
 */
const ROOT = import.meta.dirname;
const PKG = resolve(ROOT, "..");

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};
const EAGER = new Set(["import-statement", "require-call"]);
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx"];

function resolveRelative(importer: string, specifier: string): string | null {
  const base = resolve(dirname(importer), specifier);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every first-party file an entry evaluates, as package-relative paths. */
function reaches(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(PKG, entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const transpiler = file.endsWith("x") ? transpilers.tsx : transpilers.ts;
    for (const imported of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!EAGER.has(imported.kind)) continue;
      // Third-party specifiers are someone else's graph; react is expected.
      if (!imported.path.startsWith(".")) continue;
      const target = resolveRelative(file, imported.path);
      if (target) queue.push(target);
    }
  }

  return new Set([...seen].map((file) => relative(PKG, file)));
}

/** The files whose evaluation in a browser bundle is the thing being prevented. */
const SERVER_ONLY = [
  "ai/AgentProvider.ts",
  "ai/signing.ts",
  "ai/Agent.ts",
  "ai/AgentController.ts",
  "ai/Schema.ts",
];

describe("gemi/ai/client", () => {
  test("reaches no module that holds a key, a secret or a tool's execute", () => {
    const graph = reaches("ai/client/index.ts");
    const leaked = SERVER_ONLY.filter((file) => graph.has(file));
    expect(leaked).toEqual([]);
  });

  test("reaches nothing under ai/providers, where the API clients live", () => {
    const graph = reaches("ai/client/index.ts");
    expect([...graph].filter((file) => file.startsWith("ai/providers/"))).toEqual([]);
  });

  test("still reaches the hook and its decoder, so the walk is not vacuous", () => {
    // Without this, deleting the export would make the two tests above pass.
    const graph = reaches("ai/client/index.ts");
    expect(graph).toContain("ai/useChat.tsx");
    expect(graph).toContain("ai/client/sse.ts");
    expect(graph).toContain("ai/client/reducer.ts");
  });
});

describe("gemi/ai", () => {
  test("reaches the server module it is the entry for", () => {
    const graph = reaches("ai/index.ts");
    for (const file of SERVER_ONLY) {
      expect(graph).toContain(file);
    }
  });

  test("does not pull the React hook into a server bundle", () => {
    // The wall is worth having in both directions: `useChat` in here would make
    // `gemi/ai` unimportable anywhere React is not installed, and every agent
    // definition an app writes imports `gemi/ai`.
    expect(reaches("ai/index.ts")).not.toContain("ai/useChat.tsx");
  });
});

describe("the ai entries in the exports map", () => {
  const pkg: { exports: Record<string, string> } = JSON.parse(
    readFileSync(join(PKG, "package.json"), "utf8"),
  );

  test("publishes both halves", () => {
    expect(pkg.exports["./ai"]).toBe("./ai/index.ts");
    expect(pkg.exports["./ai/client"]).toBe("./ai/client/index.ts");
  });

  /**
   * `exports-map.test.ts` checks that a source target exists; only
   * `build-publish.ts` can check the built one, against a real `dist/`. What
   * neither covers is the step between: a source entry whose builder was never
   * told about it publishes a `./dist/ai/index.js` that nothing emits, and that
   * is a publish-time failure for a module that typechecks perfectly.
   */
  test("names each half to the build that actually produces it", () => {
    expect(readFileSync(join(PKG, "scripts/build.ts"), "utf8")).toContain('"./ai/index.ts"');
    expect(readFileSync(join(PKG, "vite.client.config.mts"), "utf8")).toContain(
      '"ai/client/index"',
    );
  });
});
