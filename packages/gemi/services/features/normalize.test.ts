import { describe, expect, test } from "vitest";
import { FeatureRouter } from "../../http/FeatureRouter";
import { normalizeFlag, normalizeRules } from "./normalize";

const declare = new FeatureRouter();
const boolFlag = declare.boolean(false);
const variantFlag = declare.variant(["a", "b", "control"], "control");

function collect() {
  const warnings: string[] = [];
  return { warn: (message: string) => warnings.push(message), warnings };
}

function row(overrides: Record<string, unknown> = {}) {
  return { key: "flag", enabled: true, ...overrides };
}

describe("normalizeFlag", () => {
  test("a row with no key is dropped with a warning", () => {
    const { warn, warnings } = collect();

    expect(normalizeFlag({ enabled: true }, boolFlag, warn)).toBe(null);
    expect(warnings).toHaveLength(1);
  });

  test("enabled is strictly boolean", () => {
    expect(normalizeFlag(row({ enabled: 1 }), boolFlag).enabled).toBe(false);
    expect(normalizeFlag(row({ enabled: "true" }), boolFlag).enabled).toBe(false);
    expect(normalizeFlag(row({ enabled: true }), boolFlag).enabled).toBe(true);
  });

  test("null value columns fall back to the declared default", () => {
    const declaredTrue = declare.boolean(true);
    const flag = normalizeFlag(row({ offValue: null, defaultValue: null }), declaredTrue);

    expect(flag.offValue).toBe(true);
    expect(flag.defaultValue).toBe(true);
  });

  test("object value columns are refused in favour of the declared default", () => {
    const flag = normalizeFlag(row({ defaultValue: { nested: true } }), boolFlag);

    expect(flag.defaultValue).toBe(false);
  });

  test("seed falls back to the key so bucketing is still stable", () => {
    expect(normalizeFlag(row({ seed: null }), boolFlag).seed).toBe("flag");
    expect(normalizeFlag(row({ seed: "s" }), boolFlag).seed).toBe("s");
  });

  test("serverOnly comes from the declaration, not the row", () => {
    const hidden = declare.boolean(false).serverOnly();

    // A row must not be able to publish a flag the app declared server-only.
    expect(normalizeFlag(row({ serverOnly: false }), hidden).serverOnly).toBe(true);
    expect(normalizeFlag(row({ serverOnly: true }), boolFlag).serverOnly).toBe(false);
  });
});

describe("normalizeRules — hostile input", () => {
  test("absent rules are an empty list", () => {
    expect(normalizeRules(undefined, "flag", boolFlag)).toEqual([]);
    expect(normalizeRules(null, "flag", boolFlag)).toEqual([]);
  });

  test("a non-array is ignored with a warning, not thrown", () => {
    const { warn, warnings } = collect();

    expect(normalizeRules({ not: "an array" }, "flag", boolFlag, warn)).toEqual([]);
    expect(normalizeRules("garbage", "flag", boolFlag, warn)).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("a JSON string column is parsed", () => {
    const rules = normalizeRules(
      JSON.stringify([{ id: "r1", value: true }]),
      "flag",
      boolFlag,
    );

    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("r1");
  });

  test("unparseable JSON yields no rules rather than throwing", () => {
    expect(() => normalizeRules("{oh no", "flag", boolFlag)).not.toThrow();
    expect(normalizeRules("{oh no", "flag", boolFlag)).toEqual([]);
  });

  test("null and non-object entries are skipped individually", () => {
    const { warn, warnings } = collect();
    const rules = normalizeRules(
      [null, "nope", 42, { id: "good", value: true }],
      "flag",
      boolFlag,
      warn,
    );

    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("good");
    expect(warnings).toHaveLength(3);
  });

  test("a rule with no id gets a positional one", () => {
    const rules = normalizeRules([{ value: true }], "flag", boolFlag);

    expect(rules[0].id).toBe("rule-0");
  });

  test("a bucketing rule with no id warns about re-bucketing", () => {
    const { warn, warnings } = collect();
    normalizeRules([{ rollout: 50, value: true }], "flag", boolFlag, warn);

    expect(warnings.join(" ")).toMatch(/re-bucket/i);
  });

  test("a rule with a stable id does not warn", () => {
    const { warn, warnings } = collect();
    normalizeRules([{ id: "r1", rollout: 50, value: true }], "flag", boolFlag, warn);

    expect(warnings).toEqual([]);
  });
});

describe("normalizeRules — conditions", () => {
  test("an unknown operator drops the whole rule, not just the condition", () => {
    // Dropping one condition would widen the rule: the rest are ANDed, so
    // removing one lets more people through than the author intended.
    const { warn, warnings } = collect();
    const rules = normalizeRules(
      [{ id: "r1", conditions: [{ attribute: "plan", operator: "regex", value: ".*" }], value: true }],
      "flag",
      boolFlag,
      warn,
    );

    expect(rules).toEqual([]);
    expect(warnings.join(" ")).toMatch(/unknown operator/i);
  });

  test("a condition missing attribute or operator drops the rule", () => {
    expect(
      normalizeRules([{ id: "r1", conditions: [{ attribute: "plan" }], value: true }], "flag", boolFlag),
    ).toEqual([]);
    expect(
      normalizeRules([{ id: "r1", conditions: [{ operator: "eq" }], value: true }], "flag", boolFlag),
    ).toEqual([]);
  });

  test("non-array conditions drop the rule", () => {
    expect(
      normalizeRules([{ id: "r1", conditions: "all", value: true }], "flag", boolFlag),
    ).toEqual([]);
  });

  test("valid conditions survive intact", () => {
    const rules = normalizeRules(
      [{ id: "r1", conditions: [{ attribute: "plan", operator: "eq", value: "pro" }], value: true }],
      "flag",
      boolFlag,
    );

    expect(rules[0].conditions).toEqual([{ attribute: "plan", operator: "eq", value: "pro" }]);
  });
});

describe("normalizeRules — rollout and variants", () => {
  test("a non-numeric rollout drops the rule", () => {
    expect(normalizeRules([{ id: "r1", rollout: "50", value: true }], "flag", boolFlag)).toEqual([]);
    expect(normalizeRules([{ id: "r1", rollout: Number.NaN, value: true }], "flag", boolFlag)).toEqual([]);
  });

  test("an out-of-range rollout is clamped rather than discarded", () => {
    expect(normalizeRules([{ id: "r1", rollout: 120, value: true }], "flag", boolFlag)[0].rollout).toBe(100);
    expect(normalizeRules([{ id: "r1", rollout: -5, value: true }], "flag", boolFlag)[0].rollout).toBe(0);
  });

  test("a variant outside the declared set drops the whole rule", () => {
    // Dropping just the bad arm would redistribute its share across the others,
    // changing the experiment for everyone rather than only the broken arm.
    const { warn, warnings } = collect();
    const rules = normalizeRules(
      [
        {
          id: "r1",
          variants: [
            { value: "a", weight: 50 },
            { value: "typo", weight: 50 },
          ],
        },
      ],
      "flag",
      variantFlag,
      warn,
    );

    expect(rules).toEqual([]);
    expect(warnings.join(" ")).toMatch(/not one of the declared values/i);
  });

  test("a rule value outside the declared set drops the rule", () => {
    expect(normalizeRules([{ id: "r1", value: "typo" }], "flag", variantFlag)).toEqual([]);
    expect(normalizeRules([{ id: "r1", value: "a" }], "flag", variantFlag)).toHaveLength(1);
  });

  test("non-variant flags accept any scalar value", () => {
    expect(normalizeRules([{ id: "r1", value: true }], "flag", boolFlag)).toHaveLength(1);
  });

  test("a negative or non-numeric weight drops the rule", () => {
    expect(
      normalizeRules([{ id: "r1", variants: [{ value: "a", weight: -1 }] }], "flag", variantFlag),
    ).toEqual([]);
    expect(
      normalizeRules([{ id: "r1", variants: [{ value: "a", weight: "50" }] }], "flag", variantFlag),
    ).toEqual([]);
  });

  test("empty variants drop the rule", () => {
    expect(normalizeRules([{ id: "r1", variants: [] }], "flag", variantFlag)).toEqual([]);
  });

  test("valid variants survive", () => {
    const rules = normalizeRules(
      [
        {
          id: "r1",
          variants: [
            { value: "a", weight: 50 },
            { value: "b", weight: 50 },
          ],
        },
      ],
      "flag",
      variantFlag,
    );

    expect(rules[0].variants).toEqual([
      { value: "a", weight: 50 },
      { value: "b", weight: 50 },
    ]);
  });
});

describe("no input throws", () => {
  test("a fuzz sweep of malformed shapes is survivable", () => {
    const shapes: unknown[] = [
      undefined,
      null,
      0,
      "",
      "[]",
      "[{}]",
      [{}],
      [[]],
      [{ id: 1 }],
      [{ id: "r", conditions: [null] }],
      [{ id: "r", variants: [null] }],
      [{ id: "r", variants: {} }],
      [{ id: "r", rollout: {} }],
      [{ id: "r", segments: "one" }],
      [{ id: "r", value: [] }],
      [{ id: "r", bucketBy: 5 }],
    ];

    for (const shape of shapes) {
      expect(() => normalizeRules(shape, "flag", variantFlag), JSON.stringify(shape)).not.toThrow();
    }
  });
});
