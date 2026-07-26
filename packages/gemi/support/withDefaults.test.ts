import { describe, expect, it } from "vitest";
import { withDefaults } from "./withDefaults";

describe("withDefaults", () => {
  it("falls back to the default for a missing key", () => {
    expect(withDefaults({ a: 1, b: 2 }, { a: 9 })).toEqual({ a: 9, b: 2 });
  });

  it("falls back to the default for an explicit undefined", () => {
    expect(withDefaults({ a: 1, b: 2 }, { a: undefined })).toEqual({
      a: 1,
      b: 2,
    });
  });

  it("keeps an explicit null, which is a real value", () => {
    expect(withDefaults({ a: 1 }, { a: null })).toEqual({ a: null });
  });

  it("treats a missing config object as all defaults", () => {
    expect(withDefaults({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("does not mutate either argument", () => {
    const defaults = { a: 1 };
    const config = { a: 2 };
    withDefaults(defaults, config);
    expect(defaults).toEqual({ a: 1 });
    expect(config).toEqual({ a: 2 });
  });
});
