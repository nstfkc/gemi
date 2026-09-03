import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every gemi API the shipped agent skill names, checked against what gemi
 * actually exports.
 *
 * This exists because the skill shipped with three APIs the framework does not
 * have. `TranslationService.transform` was an entire rule — 50 lines with an
 * incorrect/correct pair — built on a class that lives in one private
 * application and nowhere in this package. `useDebounceValue` was presented in a
 * table of gemi replacements while actually coming from `usehooks-ts`. An
 * `analytics` connection pool was described as though the framework provided it.
 *
 * None of that is catchable by review at the pace rules get added: the file
 * reads exactly like the 40 correct ones. And the failure mode is the worst
 * available for a document whose only reader is an agent — it does not error, it
 * produces confident code against an API that was never there.
 *
 * `docs-imports.test.ts` is the neighbour that does this for the documentation.
 * This is the same check for the skill, which ships to every gemi app inside the
 * package and so has a wider blast radius than the docs do.
 *
 * It is deliberately narrow. It checks the two things that are mechanically
 * decidable — imports from `gemi/*`, and identifiers claimed as gemi hooks or
 * facades — and cannot check prose. A rule that describes a real API's behaviour
 * wrongly still passes here.
 */

const ROOT = import.meta.dirname;
const SKILL = join(ROOT, "skills/gemi-react-best-practices");

const files = [
  join(SKILL, "SKILL.md"),
  ...readdirSync(join(SKILL, "rules"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(SKILL, "rules", name)),
];

const sources = files.map((path) => ({
  path: path.slice(ROOT.length + 1),
  text: readFileSync(path, "utf8"),
}));

async function exportsOf(entry: string): Promise<Set<string>> {
  return new Set(Object.keys(await import(join(ROOT, entry))));
}

describe("the shipped agent skill", () => {
  test("names at least the rules it claims to", () => {
    // Guards against a glob that matched nothing, which would make every
    // assertion below vacuously true.
    expect(sources.length).toBeGreaterThanOrEqual(40);
  });

  test('every `from "gemi/…"` import names a real entrypoint export', async () => {
    const entrypoints: Record<string, string> = {
      "gemi/client": "client/index.ts",
      "gemi/http": "http/index.ts",
      "gemi/orm": "orm/index.ts",
      "gemi/testing": "testing/index.ts",
      "gemi/facades": "facades/index.ts",
      "gemi/services": "services/index.ts",
      "gemi/support": "support/index.ts",
      "gemi/i18n": "i18n/index.ts",
      "gemi/config": "config/index.ts",
    };

    const missing: string[] = [];
    for (const { path, text } of sources) {
      // `import { a, b } from "gemi/x"` — the shape every snippet uses.
      for (const match of text.matchAll(/import\s+\{([^}]+)\}\s+from\s+"(gemi\/[a-z]+)"/g)) {
        const [, named, entry] = match;
        const file = entrypoints[entry!];
        if (!file) {
          missing.push(`${path}: unknown entrypoint "${entry}"`);
          continue;
        }
        const available = await exportsOf(file);
        for (const raw of named!.split(",")) {
          const name = raw
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0]!
            .trim();
          if (name && !available.has(name)) {
            missing.push(`${path}: "${entry}" does not export \`${name}\``);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("every identifier it presents as a gemi hook is exported by gemi/client", async () => {
    // A hook named in a rule is being recommended. `useDebounceValue` was named
    // in a table of gemi replacements and comes from a third-party package.
    const available = await exportsOf("client/index.ts");
    const reactBuiltins = new Set([
      "useState",
      "useEffect",
      "useMemo",
      "useCallback",
      "useRef",
      "useContext",
      "useReducer",
      "useTransition",
      "useDeferredValue",
      "useId",
      "useSyncExternalStore",
      "useLayoutEffect",
      "useOptimistic",
      "useActionState",
    ]);

    const unknown = new Map<string, string[]>();
    for (const { path, text } of sources) {
      for (const [name] of text.matchAll(/\buse[A-Z][A-Za-z0-9]*/g)) {
        if (reactBuiltins.has(name) || available.has(name)) continue;
        // A hook the rule defines or imports from an app path is the app's own,
        // and the surrounding text has to make that clear; the check is that it
        // is not passed off as gemi's.
        if (new RegExp(`(function|const)\\s+${name}\\b`).test(text)) continue;
        if (new RegExp(`import[^\\n]*${name}[^\\n]*from\\s+"(?!gemi)`).test(text)) continue;
        unknown.set(name, [...(unknown.get(name) ?? []), path]);
      }
    }
    expect(Object.fromEntries(unknown)).toEqual({});
  });

  test("every identifier it uses as a facade is exported by gemi/facades", async () => {
    // `TranslationService.transform(...)` read exactly like `Storage.put(...)`.
    // The difference is only visible against the export list.
    const available = await exportsOf("facades/index.ts");
    // Names used as illustrative application models and classes in examples,
    // rather than as framework facades.
    const appExamples =
      /^(Model|Job|Service|Command|CronJob|Listener|Dictionary|Promise|Object|Array|JSON|Math|Number|String|Date|Error|Response|Request|React|Boolean|Set|Map)$/;
    // A call in an ORM or job position is an example model, whatever it is
    // called — `Store.findUnique(…)` is not a claim that gemi exports `Store`.
    // `TranslationService.transform(…)` is not in this shape, which is what made
    // it findable.
    const modelMethods =
      /^(findMany|findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy|transaction|on|save|wrap|dispatch|asSystem|asUser)$/;

    const unknown = new Map<string, string[]>();
    for (const { path, text } of sources) {
      // Only names the skill *imports from* `gemi/facades`, or uses in a
      // `Facade.method()` position while also naming `gemi/facades` in the file.
      if (!text.includes("gemi/facades")) continue;
      for (const [, name, method] of text.matchAll(
        /\b([A-Z][A-Za-z0-9]*)\.([a-z][A-Za-z0-9]*)\(/g,
      )) {
        if (available.has(name!) || appExamples.test(name!)) continue;
        if (modelMethods.test(method!)) continue;
        // Declared in the snippet itself — an example model or class.
        if (new RegExp(`class\\s+${name}\\b`).test(text)) continue;
        unknown.set(name!, [...(unknown.get(name!) ?? []), path]);
      }
    }
    expect(Object.fromEntries(unknown)).toEqual({});
  });

  test("names no package that only one application has", () => {
    // The skill was written against a single private app. These are the shapes
    // that leaked: a scoped package from that repo, and paths into its views.
    const leaks: string[] = [];
    for (const { path, text } of sources) {
      for (const pattern of [/@folio\//i, /folio-ai-concept/i, /usehooks-ts/, /in-house/i]) {
        if (pattern.test(text)) leaks.push(`${path}: ${pattern}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
