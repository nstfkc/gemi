import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
 * Two checks, because neither alone is enough:
 *
 *   1. `loadedBy()` really imports each barrel in a child Bun process, with a
 *      plugin whose `onLoad` watches every module under the heavy packages. It
 *      answers the question that matters — *was this evaluated* — so it catches
 *      any eager shape, including a module-scope `await import("sharp")`, which
 *      is awaited during the importer's own evaluation and is every bit as
 *      eager as a static import.
 *   2. `walk()` reads the static import graph. It cannot see that
 *      top-level-await shape, but when something does go eager it names the
 *      file that did it, and it runs without the heavy packages installed.
 *
 * Scope, so a passing run is not read as more than it is:
 *
 *   - Both watch the packages listed in `HEAVY`. A *new* heavy dependency added
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

/** Matches any file inside one of the `HEAVY` packages, on either separator. */
const HEAVY_PATH_SOURCE = `[\\\\/]node_modules[\\\\/](${HEAVY.map((name) =>
  name.replace("/", "[\\\\/]"),
).join("|")})[\\\\/]`;

// ---------------------------------------------------------------------------
// 1. Did importing the barrel actually evaluate any of them?
// ---------------------------------------------------------------------------

/**
 * Imports `target` in a child Bun process and returns the `HEAVY` packages that
 * were loaded while it did.
 *
 * `onLoad` rather than `onResolve`: a runtime plugin's `onResolve` is not
 * consulted for a bare specifier that Bun's module loader resolves on its own,
 * so it never sees `import sharp from "sharp"`. `onLoad` sees every module that
 * is actually read, which is the question being asked.
 *
 * The hook has to return something, so it returns an empty module. Anything it
 * matched has already failed the test, and stubbing keeps the first heavy
 * package from dragging in the rest before the child reports what it found.
 */
function loadedBy(target: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "gemi-barrel-"));

  try {
    writeFileSync(
      join(dir, "probe.ts"),
      [
        `import { plugin } from "bun";`,
        `const HEAVY = /${HEAVY_PATH_SOURCE}/;`,
        `const seen = new Set();`,
        `plugin({`,
        `  name: "gemi-barrel-probe",`,
        `  setup(build) {`,
        `    build.onLoad({ filter: HEAVY }, (args) => {`,
        `      const name = args.path.match(HEAVY)[1].replace(/\\\\/g, "/");`,
        `      if (!seen.has(name)) {`,
        `        seen.add(name);`,
        `        console.log("gemi-loaded:" + name);`,
        `      }`,
        `      return { contents: "", loader: "js" };`,
        `    });`,
        `  },`,
        `});`,
        ``,
      ].join("\n"),
    );

    writeFileSync(
      join(dir, "entry.ts"),
      `await import(${JSON.stringify(target)});\nconsole.log("gemi-barrel-ok");\n`,
    );

    // `process.execPath` is the Bun binary the suite already runs under
    // (`bun --bun vitest`), so this does not depend on `bun` being on PATH.
    const result = spawnSync(
      process.execPath,
      ["--preload", join(dir, "probe.ts"), join(dir, "entry.ts")],
      { cwd: ROOT, encoding: "utf8" },
    );

    const stdout = result.stdout ?? "";
    const loaded = [...stdout.matchAll(/^gemi-loaded:(.+)$/gm)].map((m) => m[1]);

    // A child that died for some *other* reason would otherwise look like a
    // clean graph. Loading a heavy package is allowed to kill it — the stub
    // above guarantees that — so this only applies when nothing was found.
    if (loaded.length === 0 && !stdout.includes("gemi-barrel-ok")) {
      throw new Error(
        `Importing ${target} failed in the child process.\n` +
          `${stdout}\n${result.stderr ?? ""}`,
      );
    }

    return loaded.sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. Which file introduced it?
// ---------------------------------------------------------------------------

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/**
 * `import x from "…"` and `require("…")` evaluate the target as the importer
 * loads. `import("…")` *inside a function* does not, which is the distinction
 * every fix for #403 turns on.
 *
 * A module-scope `await import("…")` is eager despite landing in the same
 * bucket here as the lazy one. `loadedBy()` above is what covers that gap.
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
  /** Heavy package -> the files that import it eagerly. */
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
  test("loads no heavy SDK when it is imported", () => {
    // `CronJob` is a 90-line dependency-free file, and `DB.connection()` is a
    // database call. Reaching either through its barrel must not cost the AWS
    // SDK, Resend, satori, or a native image binary.
    expect(loadedBy(join(ROOT, entry))).toEqual([]);
  }, 60_000);

  test("holds no eager import of one, so none is a hoist away", () => {
    // Redundant with the check above on today's code, and reported separately
    // because this is the one that can say *which file*.
    expect(describeHeavy(walk(entry))).toEqual([]);
  });

  test("is walked in full, so the check above cannot pass vacuously", () => {
    const graph = walk(entry);
    // A relative specifier that resolves to nothing silently prunes everything
    // beneath it, and `describeHeavy` would come back empty because of the hole.
    expect(graph.unresolved).toEqual([]);
    // And a walk that stopped at the barrel itself would also look clean. Pinned
    // well under the ≈150 files `services` reaches today, and the ≈105 of
    // `facades`.
    expect(graph.visited).toBeGreaterThan(50);
  });
});

describe("the guards themselves", () => {
  test("the child process reports a package that really is loaded", () => {
    // Without this the assertions above pass just as happily when the plugin
    // stops matching — a guard that cannot fail is not one. `resend` stands in
    // for all five: one filter watches them together.
    const resend = createRequire(import.meta.url).resolve("resend");

    expect(loadedBy(resend)).toEqual(["resend"]);
  }, 60_000);

  test("the walk counts a static import and not a deferred one", () => {
    const scan = (code: string) =>
      transpilers.ts.scanImports(code).filter((i) => EAGER.has(i.kind));

    expect(scan(`import sharp from "sharp";`)).toHaveLength(1);
    expect(scan(`export { Resend } from "resend";`)).toHaveLength(1);
    expect(scan(`const s = await import("sharp");`)).toHaveLength(0);
    expect(scan(`import type sharp from "sharp";`)).toHaveLength(0);
  });
});
