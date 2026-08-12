import { describe, expect, test } from "vitest";
import { gemiDictionaryPlugin } from "./dictionaryPlugin";
import { dictionaryId } from "../i18n/dictionaryShape";

/**
 * The plugin is what makes the whole design pay off — without it every locale
 * ships to every visitor and `defineDictionary` is just a worse
 * `Dictionary.create`. So these check the two halves that have to agree: the
 * rewritten call site, and the per-locale module it points at.
 */

/**
 * A stand-in for the bits of the Rollup plugin context the plugin touches.
 * `this.error` throws, matching Rollup, so the "must be static" cases can be
 * asserted with `rejects`.
 */
function ctx(warnings: string[] = []) {
  return {
    error(e: any): never {
      throw new Error(typeof e === "string" ? e : e.message);
    },
    warn(w: any) {
      warnings.push(typeof w === "string" ? w : w.message);
    },
    async load() {
      return null;
    },
  };
}

const plugin = () => gemiDictionaryPlugin() as any;

async function transform(
  p: any,
  code: string,
  id = "/app/views/Home.i18n.ts",
  warnings: string[] = [],
) {
  return await p.transform.call(ctx(warnings), code, id);
}

async function load(p: any, id: string) {
  const resolved = p.resolveId.call(ctx(), id);
  return await p.load.call(ctx(), resolved);
}

/** Warnings emitted while transforming `code`. */
async function warningsFor(code: string, id?: string): Promise<string[]> {
  const collected: string[] = [];
  await transform(plugin(), code, id, collected);
  return collected;
}

/** The specifier of the Nth `import(...)` in the rewritten output. */
function importSpecifiers(code: string): string[] {
  return Array.from(code.matchAll(/import\("([^"]+)"\)/g), (m) => m[1]);
}

const SOURCE = `
import { defineDictionary } from "gemi/client";
export const dict = defineDictionary({
  title: { "en-US": "Welcome {{name}}", "tr-TR": "Hoş geldin {{name}}" },
  cta: { "en-US": "Get started", "tr-TR": "Başla" },
});
`;

describe("the dictionary plugin's transform", () => {
  test("replaces the literal with one lazy import per locale", async () => {
    const result = await transform(plugin(), SOURCE);

    expect(result.code).toContain("__gemi_dict__(");
    // The point of the exercise: no translation survives in the module that
    // declared them.
    expect(result.code).not.toContain("Welcome");
    expect(result.code).not.toContain("Hoş geldin");
    expect(result.code).not.toContain("Başla");

    const specifiers = importSpecifiers(result.code);
    expect(specifiers).toHaveLength(2);
    expect(specifiers[0]).toMatch(/\/en-US$/);
    expect(specifiers[1]).toMatch(/\/tr-TR$/);
  });

  test("uses the same id the runtime derives from the same literal", async () => {
    const result = await transform(plugin(), SOURCE);

    // Not cosmetic: the server streams strings keyed by this id and the client
    // registry looks them up by the id its own `defineDictionary` computed. If
    // the two ever diverge, hydration silently refetches every dictionary.
    const expected = dictionaryId({
      title: { "en-US": "Welcome {{name}}", "tr-TR": "Hoş geldin {{name}}" },
      cta: { "en-US": "Get started", "tr-TR": "Başla" },
    });

    expect(result.code).toContain(`__gemi_dict__(${JSON.stringify(expected)}`);
  });

  test("imports the runtime from the entrypoint that stays external under SSR", async () => {
    const result = await transform(plugin(), SOURCE);
    expect(result.code).toContain(
      `import { __gemi_dict__ } from "gemi/dictionary"`,
    );
  });

  test("follows a renamed import", async () => {
    const result = await transform(
      plugin(),
      `
      import { defineDictionary as dd } from "gemi/i18n";
      export const dict = dd({ a: { "en-US": "A" } });
      `,
    );
    expect(result.code).toContain("__gemi_dict__(");
  });

  test("leaves alone a module that never imports it", async () => {
    // The name alone must not be enough — an app is free to have its own
    // `defineDictionary`.
    const result = await transform(
      plugin(),
      `function defineDictionary(x) { return x }
       export const dict = defineDictionary({ a: { "en-US": "A" } });`,
    );
    expect(result).toBeNull();
  });

  test("emits a sourcemap so the original lines survive", async () => {
    const result = await transform(plugin(), SOURCE);
    expect(result.map).toBeTruthy();
  });
});

describe("the dictionary plugin's virtual modules", () => {
  test("each locale's module carries only that locale", async () => {
    const p = plugin();
    const result = await transform(p, SOURCE);
    const [en, tr] = importSpecifiers(result.code);

    const enModule = await load(p, en);
    expect(enModule).toContain("Welcome {{name}}");
    expect(enModule).not.toContain("Hoş geldin");

    const trModule = await load(p, tr);
    expect(trModule).toContain("Hoş geldin {{name}}");
    expect(trModule).not.toContain("Welcome {{name}}");
  });

  test("a key missing from a locale falls back to the source language", async () => {
    // Half-translated dictionaries are the normal state of a growing app. The
    // untranslated key should render in the source language, not as its own
    // name.
    const p = plugin();
    const result = await transform(
      p,
      `
      import { defineDictionary } from "gemi/client";
      export const dict = defineDictionary({
        done: { "en-US": "Done", "tr-TR": "Bitti" },
        pending: { "en-US": "Pending" },
      });
      `,
    );
    const tr = importSpecifiers(result.code).find((s) => s.endsWith("/tr-TR"))!;

    const trModule = await load(p, tr);
    expect(trModule).toContain("Bitti");
    expect(trModule).toContain("Pending");
  });
});

describe("calls the import scan cannot resolve", () => {
  /**
   * The transform is what makes locale splitting real, so a call it silently
   * declines to rewrite ships every locale to every visitor — the exact outcome
   * `readObjectLiteral` hard-fails the build to avoid. These forms cannot be
   * rewritten safely, so the least they must do is say so.
   */
  test("a namespace import warns", async () => {
    const warnings = await warningsFor(
      `import * as gemi from "gemi/client";
       export const d = gemi.defineDictionary({ a: { "en-US": "A" } });`,
    );
    expect(warnings.join()).toMatch(/could not be traced to an import/);
  });

  test("a re-export through an app-local barrel warns", async () => {
    const warnings = await warningsFor(
      `import { defineDictionary } from "@/app/lib/gemi";
       export const d = defineDictionary({ a: { "en-US": "A" } });`,
    );
    expect(warnings.join()).toMatch(/could not be traced to an import/);
  });

  test("an app's own defineDictionary does not warn", async () => {
    // Noise is how a real warning gets ignored.
    const warnings = await warningsFor(
      `function defineDictionary(x) { return x }
       export const d = defineDictionary({ a: { "en-US": "A" } });`,
    );
    expect(warnings).toEqual([]);
  });

  test("a properly imported call warns about nothing", async () => {
    expect(await warningsFor(SOURCE)).toEqual([]);
  });
});

describe("sourceLocale", () => {
  const HALF_TRANSLATED = `
    import { defineDictionary } from "gemi/client";
    export const dict = defineDictionary({
      onlyTr: { "tr-TR": "Merhaba" },
      both: { "en-US": "Hello", "tr-TR": "Merhaba" },
    }, { sourceLocale: "en-US" });
  `;

  test("pins the fallback language regardless of key order", async () => {
    // Without the pin, `onlyTr` coming first makes tr-TR the source language
    // for the whole dictionary, so `both` would fall back to Turkish for
    // English readers — from a diff that only reordered keys.
    const p = plugin();
    const result = await transform(p, HALF_TRANSLATED);
    const en = importSpecifiers(result.code).find((s) => s.endsWith("/en-US"))!;

    expect(en).toBeTruthy();
    const enModule = await load(p, en);
    expect(enModule).toContain("Hello");
    // The untranslated key still degrades to the one string that exists.
    expect(enModule).toContain("Merhaba");
  });

  test("puts the source locale first in the loader map", async () => {
    const result = await transform(plugin(), HALF_TRANSLATED);
    expect(importSpecifiers(result.code)[0]).toMatch(/\/en-US$/);
  });

  test("must be a string literal", async () => {
    await expect(
      transform(
        plugin(),
        `import { defineDictionary } from "gemi/client";
         const l = "en-US";
         export const d = defineDictionary({ a: { "en-US": "A" } }, { sourceLocale: l });`,
      ),
    ).rejects.toThrow(/sourceLocale/);
  });
});

describe("the dictionary plugin's build errors", () => {
  const cases: Array<[string, string]> = [
    [
      "a variable instead of a literal",
      `import { defineDictionary } from "gemi/client";
       const t = {}; export const d = defineDictionary(t);`,
    ],
    [
      "a template literal value",
      "import { defineDictionary } from \"gemi/client\";\nexport const d = defineDictionary({ a: { \"en-US\": `hi` } });",
    ],
    [
      "a computed key",
      `import { defineDictionary } from "gemi/client";
       const k = "a"; export const d = defineDictionary({ [k]: { "en-US": "A" } });`,
    ],
    [
      "a spread",
      `import { defineDictionary } from "gemi/client";
       const rest = {}; export const d = defineDictionary({ ...rest });`,
    ],
  ];

  // Failing the build is the point. Quietly skipping an unreadable dictionary
  // would leave it shipping every locale to the browser with nothing to notice.
  for (const [name, code] of cases) {
    test(`fails on ${name}`, async () => {
      await expect(transform(plugin(), code)).rejects.toThrow(
        /defineDictionary/,
      );
    });
  }
});
