import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `gemi/services` and `gemi/facades` are barrels, and `exports` publishes no
 * subpaths beneath them — so they are the *only* door an application has to
 * `CronJob`, `Job`, `Command`, `DB` and `Lang`. Anything a barrel re-exports is
 * therefore paid for by every app and every test that reaches any of those.
 *
 * They used to re-export five drivers that imported their SDK at module scope,
 * so `import { CronJob } from "gemi/services"` — the line the saas-starter
 * template teaches — evaluated `@aws-sdk/client-s3`, `resend`, `satori` and
 * `sharp`, and `import { DB } from "gemi/facades"` did the same to `sharp` for
 * a database test (#403). A bundler can sometimes shake that out; a test runner
 * never can.
 *
 * The check is a walk of the *static* import graph rather than an instrumented
 * run, because Bun offers nothing that observes the second: a runtime plugin's
 * `onResolve` fires for `await import(x)` and not for `import x from "…"`, so
 * an instrumented child process reports a clean graph even when the eager
 * import is right there. Reading the imports is the thing that can tell the two
 * apart, and it names the file that introduced one.
 *
 * Scope, so a passing run is not read as more than it is:
 *
 *   - It watches the packages listed in `HEAVY`. A *new* heavy dependency added
 *     to a barrel is not caught until someone adds it here.
 *   - `bun` is not on the list, because it cannot be yet: `database/Connection.ts`
 *     still imports `SQL` as a value, so `gemi/facades` remains Bun-only. The
 *     `RedisManager` half of that (#396) is fixed — it reaches Bun's Redis
 *     client through the `Bun` global — but the database half is its own change.
 *   - `twitter-api-v2` is not on it either, and is still eager:
 *     `XOAuthProvider` builds its `TwitterApi` in the constructor and reads it
 *     from a *synchronous* `getRedirectUrl()`, so deferring the import means
 *     changing the `OAuthProvider` contract rather than moving a line.
 */
const HEAVY = [
  "sharp",
  "resend",
  "satori",
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
];

const ROOT = import.meta.dirname;

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/**
 * `import x from "…"` and `require("…")` both evaluate the target as the
 * importer loads. `import("…")` does not, which is the whole distinction this
 * file exists to hold: every fix for #403 moved a specifier from the first
 * category to the second.
 *
 * `import type` never appears here at all — the transpiler elides it — so a
 * type-only reference to `sharp` is correctly not a cost.
 */
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

/** `@scope/name/deep` -> `@scope/name`; `name/deep` -> `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

interface Graph {
  /** Heavy package -> the files that import it eagerly, nearest first. */
  heavy: Map<string, string[]>;
  /** Relative specifiers that resolved to no file, which would hide a subtree. */
  unresolved: string[];
  visited: number;
}

/** Walks every file reachable from `entry` through eager relative imports. */
function walk(entry: string): Graph {
  const heavy = new Map<string, string[]>();
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(ROOT, entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const transpiler = file.endsWith("x") ? transpilers.tsx : transpilers.ts;
    for (const imported of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!EAGER.has(imported.kind)) continue;

      if (imported.path.startsWith(".")) {
        const target = resolveRelative(file, imported.path);
        if (target) queue.push(target);
        else unresolved.push(`${relative(ROOT, file)} -> ${imported.path}`);
        continue;
      }

      const pkg = packageOf(imported.path);
      if (!HEAVY.includes(pkg)) continue;
      heavy.set(pkg, [...(heavy.get(pkg) ?? []), relative(ROOT, file)]);
    }
  }

  return { heavy, unresolved, visited: seen.size };
}

function describeHeavy(graph: Graph): string[] {
  return [...graph.heavy]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, importers]) => `${pkg} <- ${importers.sort().join(", ")}`);
}

describe.each([
  ["gemi/services", "services/index.ts"],
  ["gemi/facades", "facades/index.ts"],
])("%s", (_subpath, entry) => {
  const graph = walk(entry);

  test("evaluates no heavy SDK when it is imported", () => {
    // `CronJob` is a 90-line dependency-free file, and `DB.connection()` is a
    // database call. Reaching either through its barrel must not cost the AWS
    // SDK, Resend, satori, or a native image binary.
    expect(describeHeavy(graph)).toEqual([]);
  });

  test("the walk reached the whole graph", () => {
    // A relative specifier that resolves to nothing silently prunes everything
    // beneath it, and the assertion above would pass because of the hole.
    expect(graph.unresolved).toEqual([]);
    // And a walk that stopped at the barrel itself would also pass. Pinned well
    // under the ~110 files each entry currently reaches.
    expect(graph.visited).toBeGreaterThan(50);
  });
});

describe("the import walk", () => {
  test("counts a static import and not a dynamic one", () => {
    // The two assertions above are only worth anything if `walk` can tell an
    // eager import from a lazy one — every fix for #403 is exactly that edit.
    const scan = (code: string) =>
      transpilers.ts.scanImports(code).filter((i) => EAGER.has(i.kind));

    expect(scan(`import sharp from "sharp";`)).toHaveLength(1);
    expect(scan(`export { Resend } from "resend";`)).toHaveLength(1);
    expect(scan(`const s = await import("sharp");`)).toHaveLength(0);
    expect(scan(`import type sharp from "sharp";`)).toHaveLength(0);
  });
});
