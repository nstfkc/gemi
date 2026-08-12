import { describe, expectTypeOf, test } from "vitest";

import { defineDictionary } from "../i18n/defineDictionary";
import { useDictionary } from "./useDictionary";

/**
 * The selling point of `useDictionary` over `useTranslator` is that keys and
 * interpolation params come from the literal itself — no name string, no
 * `gemi.d.ts` augmentation, nothing to keep in sync. None of that is observable
 * at run time: if the `const` type parameter or the phantom brand on
 * `DictionaryHandle` stopped carrying the literal's shape, every runtime test
 * in this repo would stay green while `t` quietly accepted any key and any
 * params.
 *
 * So the negative cases below matter more than the positive ones — a `t` that
 * had degraded to `any` would satisfy the positive assertions just as happily.
 */

const dict = defineDictionary({
  greeting: { "en-US": "Hello {{name}}", "tr-TR": "Merhaba {{name}}" },
  cta: { "en-US": "Get started", "tr-TR": "Başla" },
  count: { "en-US": "You have {{total:number}} items" },
});

describe("keys", () => {
  test("a declared key is accepted and returns a string", () => {
    const t = useDictionary(dict);
    expectTypeOf(t("cta")).toBeString();
  });

  test("an undeclared key is rejected", () => {
    const t = useDictionary(dict);
    // @ts-expect-error — "nope" is not a key of this dictionary.
    t("nope");
  });
});

describe("params", () => {
  test("a placeholder makes its param required and names it", () => {
    const t = useDictionary(dict);
    t("greeting", { name: "Enes" });

    // @ts-expect-error — `greeting` interpolates {{name}}, which is missing.
    t("greeting");

    // @ts-expect-error — the placeholder is `name`, not `nombre`.
    t("greeting", { nombre: "Enes" });
  });

  test("a string with no placeholder takes no params", () => {
    const t = useDictionary(dict);
    // @ts-expect-error — `cta` interpolates nothing.
    t("cta", { name: "Enes" });
  });

  test("a `:number` placeholder accepts a number", () => {
    const t = useDictionary(dict);
    t("count", { total: 3 });
  });
});

describe("jsx", () => {
  test("t.jsx takes the same keys and params", () => {
    const t = useDictionary(dict);
    t.jsx("greeting", { name: () => "Enes" });

    // @ts-expect-error — same key checking as `t`.
    t.jsx("nope");
  });
});
