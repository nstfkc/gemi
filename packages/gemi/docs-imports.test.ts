import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every `import … from "gemi/…"` in the documentation, checked against what the
 * entrypoint actually exports.
 *
 * `docs/authentication.md` documented the only supported way to install a custom
 * `UserProvider`:
 *
 * ```typescript
 * import { AuthManager } from "gemi/services";
 * import { ServiceProvider } from "gemi/services";
 * ```
 *
 * Neither line resolved. `AuthManager` was never exported — the `// Auth`
 * section of `services/index.ts` stopped at `AuthServiceProvider`, while every
 * other manager in the file (`MailManager`, `QueueManager`, `RedisManager`, …)
 * was exported beside its provider. `ServiceProvider` had moved to
 * `gemi/support` — a move the codemod's own `MODULE_MOVES` table already knew
 * about, and the docs had not followed.
 *
 * The cost was not a broken snippet. `AuthConfig` has no provider field, so
 * rebinding `AuthManager` is the *whole* of the seam; with the export missing,
 * an application had a documented path, a container that would have accepted the
 * binding, and no way to name the token. That reads as a missing framework
 * capability rather than a missing line, and it survived two release candidates
 * being migrated against.
 *
 * What makes it worth a test rather than a fix is that nothing else could see
 * it. `tsc` does not type-check fenced code, and the docs are prose the compiler
 * never reads — so the one artifact stating the intended design was also the one
 * artifact with no check on it. This closes that: the entrypoints are parsed
 * statically, so a snippet naming an export that does not exist fails here.
 */
const ROOT = join(import.meta.dirname);
const DOCS = join(ROOT, "../../docs");

/**
 * `exports` maps subpath to file, so the docs specifier resolves the same way a
 * consumer's would — including the entrypoints that point at `dist/`, which are
 * skipped below rather than guessed at.
 */
const EXPORTS: Record<string, string> = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).exports;

/**
 * Named exports of an entrypoint, read from its source rather than imported.
 *
 * Importing would be more faithful and is not an option: `gemi/client` and
 * `gemi/runtime` pull in React DOM against a browser environment this suite does
 * not run in, and an entrypoint that throws on import would fail as though the
 * docs were wrong. A static read covers every form these index files use —
 * re-exports, type re-exports, and the one `export * as registry`.
 */
function exportsOf(entry: string): Set<string> | undefined {
  const target = join(ROOT, EXPORTS[entry]);
  // `./runtime` is a legacy entry in the `exports` map whose source does not
  // exist — `scripts/build-publish.ts` documents it as preserved only to avoid
  // changing the published surface. Reading it unguarded turns the first
  // snippet that imports `gemi/runtime` into a stack trace instead of an
  // assertion, so a missing target is reported by the caller as unresolvable.
  if (!existsSync(target)) return undefined;

  const source = readFileSync(target, "utf8");
  const names = new Set<string>();

  // `export { a, b as c }` / `export type { A }`, in one- and multi-line form.
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const clause of block[1].split(",")) {
      const name = clause.trim().split(/\s+as\s+/).pop()?.trim();
      // `export type { A }` and `export { type A }` both reach here.
      if (name) names.add(name.replace(/^type\s+/, ""));
    }
  }

  // `export * as registry from "./registry"` — the namespace is the name.
  for (const star of source.matchAll(/export\s+\*\s+as\s+([\w$]+)\s+from/g)) {
    names.add(star[1]);
  }

  // Declarations exported in place.
  for (const decl of source.matchAll(
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|type|interface|enum)\s+([\w$]+)/g,
  )) {
    names.add(decl[1]);
  }

  return names;
}

/**
 * `llms-full.txt` is the pages concatenated, so it carries every snippet a
 * second time. Checking it too is what keeps a fix to one copy from passing.
 *
 * The repository README is checked alongside them — it is the first gemi code
 * most people read, and its snippets are ordinary current-version code. The
 * root `UPGRADE.md` is deliberately excluded: it shows *pre*-0.43 source on
 * purpose (`import { Singleton } from "gemi/services"`), so checking it needs a
 * before/after fence convention that does not exist yet.
 */
const PAGES: { label: string; path: string }[] = [
  ...readdirSync(DOCS)
    .filter((file) => file.endsWith(".md") || file === "llms-full.txt")
    .map((file) => ({ label: file, path: join(DOCS, file) })),
  { label: "README.md", path: join(ROOT, "../../README.md") },
];

/** `gemi/orm` -> `./orm`, the key `exports` is written with. */
const subpathOf = (module: string) => `.${module.slice("gemi".length)}`;

interface DocImport {
  page: string;
  module: string;
  name: string;
}

const imports: DocImport[] = PAGES.flatMap(({ label, path }) => {
  const text = readFileSync(path, "utf8");
  const found: DocImport[] = [];

  for (const statement of text.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](gemi\/[\w/-]+)["']/g,
  )) {
    for (const clause of statement[1].split(",")) {
      const name = clause.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name) found.push({ page: label, module: statement[2], name: name.trim() });
    }
  }

  return found;
});

describe("documented gemi imports resolve", () => {
  /**
   * The canary. Every assertion below is over `imports`, so a regex that
   * quietly stopped matching most statements would leave them all vacuously
   * true — and a floor low enough to be safe is also low enough to miss that.
   *
   * Both halves are pinned: the count, near the ~500 the docs currently
   * produce, and the *set* of entrypoints seen. The set is the stronger of the
   * two — losing `gemi/orm` entirely still leaves hundreds of imports, so only
   * naming the modules catches a page dropping out of the sweep.
   */
  test("the sweep still sees the whole documentation surface", () => {
    expect(imports.length).toBeGreaterThan(400);

    const modules = [...new Set(imports.map((entry) => entry.module))].sort();
    expect(modules).toEqual([
      "gemi/app",
      "gemi/broadcasting",
      "gemi/client",
      "gemi/config",
      "gemi/email",
      "gemi/facades",
      "gemi/foundation",
      "gemi/http",
      "gemi/i18n",
      "gemi/kernel",
      "gemi/orm",
      "gemi/server",
      "gemi/services",
      "gemi/support",
      "gemi/testing",
    ]);
  });

  test("every subpath is in the package's exports map", () => {
    const unknown = [
      ...new Set(
        imports
          .filter((entry) => !(subpathOf(entry.module) in EXPORTS))
          .map((entry) => `${entry.module} (${entry.page})`),
      ),
    ];
    expect(unknown).toEqual([]);
  });

  test("every named import exists on the entrypoint it comes from", () => {
    // `./dist/…` entrypoints are build output, absent until `bun run build`.
    const readable = new Map<string, Set<string> | undefined>();
    const missing: string[] = [];

    for (const entry of imports) {
      const subpath = subpathOf(entry.module);
      const target = EXPORTS[subpath];
      if (!target || target.includes("/dist/")) continue;

      if (!readable.has(subpath)) readable.set(subpath, exportsOf(subpath));
      const names = readable.get(subpath);

      if (names === undefined) {
        missing.push(
          `${entry.page}: ${entry.module} maps to ${target}, which does not exist`,
        );
        continue;
      }
      if (!names.has(entry.name)) {
        missing.push(`${entry.page}: ${entry.name} from ${entry.module}`);
      }
    }

    expect(missing).toEqual([]);
  });
});
