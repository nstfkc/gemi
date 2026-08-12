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
function ctx() {
  return {
    error(e: any): never {
      throw new Error(typeof e === "string" ? e : e.message);
    },
    async load() {
      return null;
    },
  };
}

const plugin = () => gemiDictionaryPlugin() as any;

async function transform(p: any, code: string, id = "/app/views/Home.i18n.ts") {
  return await p.transform.call(ctx(), code, id);
}

async function load(p: any, id: string) {
  const resolved = p.resolveId.call(ctx(), id);
  return await p.load.call(ctx(), resolved);
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
