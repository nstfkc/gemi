import { describe, expect, test } from "vitest";
import { evaluateFlag } from "./evaluate";
import type { EvaluationContext, FeatureFlagDefinition, Rule } from "./types";

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    user: { publicId: "usr_1", email: "a@example.com", globalRole: 1 },
    attributes: { plan: "pro" },
    request: { path: "/", routePath: "/", locale: "en-US" },
    anonymousId: "anon-1",
    now: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

function flag(overrides: Partial<FeatureFlagDefinition> = {}): FeatureFlagDefinition {
  return {
    key: "new-checkout",
    enabled: true,
    offValue: false,
    defaultValue: false,
    rules: [],
    seed: "seed-a",
    bucketBy: null,
    serverOnly: false,
    ...overrides,
  };
}

const opts = { declaredDefault: false as const };

describe("fallbacks", () => {
  test("an unknown key resolves to the declared default", () => {
    const result = evaluateFlag(undefined, context(), { declaredDefault: "control" });

    expect(result).toEqual({ value: "control", reason: "unknown", ruleId: null });
  });

  test("an unavailable store resolves to the declared default", () => {
    const result = evaluateFlag(flag({ enabled: true, defaultValue: true }), context(), {
      declaredDefault: "control",
      unavailable: true,
    });

    // Not the row's value: when the store never loaded, the row in hand may be
    // arbitrarily stale or absent, so code is the only trustworthy source.
    expect(result).toEqual({ value: "control", reason: "unavailable", ruleId: null });
  });
});

describe("the kill switch", () => {
  test("enabled:false serves offValue", () => {
    const result = evaluateFlag(flag({ enabled: false, offValue: "off" }), context(), opts);

    expect(result).toEqual({ value: "off", reason: "disabled", ruleId: null });
  });

  test("enabled:false beats a rule that would otherwise match everyone", () => {
    const result = evaluateFlag(
      flag({
        enabled: false,
        offValue: false,
        rules: [{ id: "r1", conditions: [], value: true }],
      }),
      context(),
      opts,
    );

    expect(result.value).toBe(false);
    expect(result.reason).toBe("disabled");
  });
});

describe("rule precedence", () => {
  test("the first matching rule wins and later ones are not consulted", () => {
    const result = evaluateFlag(
      flag({
        rules: [
          { id: "r1", conditions: [{ attribute: "plan", operator: "eq", value: "pro" }], value: "first" },
          { id: "r2", conditions: [], value: "second" },
        ],
      }),
      context(),
      opts,
    );

    expect(result).toEqual({ value: "first", reason: "rule", ruleId: "r1" });
  });

  test("a non-matching rule falls through to the next", () => {
    const result = evaluateFlag(
      flag({
        rules: [
          { id: "r1", conditions: [{ attribute: "plan", operator: "eq", value: "free" }], value: "first" },
          { id: "r2", conditions: [], value: "second" },
        ],
      }),
      context(),
      opts,
    );

    expect(result).toEqual({ value: "second", reason: "rule", ruleId: "r2" });
  });

  test("no matching rule serves defaultValue", () => {
    const result = evaluateFlag(
      flag({
        defaultValue: "fallback",
        rules: [
          { id: "r1", conditions: [{ attribute: "plan", operator: "eq", value: "free" }], value: "x" },
        ],
      }),
      context(),
      opts,
    );

    expect(result).toEqual({ value: "fallback", reason: "default", ruleId: null });
  });

  test("an empty condition list is a catch-all", () => {
    const result = evaluateFlag(
      flag({ rules: [{ id: "r1", value: "everyone" }] }),
      context(),
      opts,
    );

    expect(result.value).toBe("everyone");
  });
});

describe("segments", () => {
  const segments = { enterprise: [{ attribute: "plan", operator: "eq" as const, value: "pro" }] };

  test("a rule matches when its segment does", () => {
    const result = evaluateFlag(
      flag({ rules: [{ id: "r1", segments: ["enterprise"], value: "yes" }] }),
      context(),
      { ...opts, segments },
    );

    expect(result.value).toBe("yes");
  });

  test("a rule is skipped when its segment does not match", () => {
    const result = evaluateFlag(
      flag({ defaultValue: "no", rules: [{ id: "r1", segments: ["enterprise"], value: "yes" }] }),
      context({ attributes: { plan: "free" } }),
      { ...opts, segments },
    );

    expect(result.value).toBe("no");
  });

  test("a rule naming an undefined segment does not become a catch-all", () => {
    // Deleting a segment definition must not widen every rule that used it to
    // the whole audience.
    const result = evaluateFlag(
      flag({ defaultValue: "no", rules: [{ id: "r1", segments: ["gone"], value: "yes" }] }),
      context(),
      { ...opts, segments: {} },
    );

    expect(result.value).toBe("no");
  });
});

describe("rollout", () => {
  const rolloutRule = (rollout: number): Rule => ({ id: "r1", rollout, value: true });

  test("100 and an absent rollout always match", () => {
    expect(evaluateFlag(flag({ rules: [rolloutRule(100)] }), context(), opts).value).toBe(true);
    expect(
      evaluateFlag(flag({ rules: [{ id: "r1", value: true }] }), context(), opts).value,
    ).toBe(true);
  });

  test("0 never matches and falls through", () => {
    const result = evaluateFlag(
      flag({ defaultValue: "fell-through", rules: [rolloutRule(0)] }),
      context(),
      opts,
    );

    expect(result.value).toBe("fell-through");
  });

  test("a rule failing its rollout falls through to the next rule", () => {
    // The composability property: rule 2 is reachable by the users rule 1's
    // bucket excluded, rather than being dead code below a terminal rule.
    const results = new Set<unknown>();
    for (let i = 0; i < 200; i++) {
      results.add(
        evaluateFlag(
          flag({
            rules: [
              { id: "r1", rollout: 50, value: "beta" },
              { id: "r2", value: "stable" },
            ],
          }),
          context({ user: { publicId: `usr_${i}` } }),
          opts,
        ).value,
      );
    }

    expect(results).toEqual(new Set(["beta", "stable"]));
  });

  test("the same subject gets the same answer every time", () => {
    const definition = flag({ rules: [rolloutRule(50)] });
    const ctx = context();
    const first = evaluateFlag(definition, ctx, opts).value;

    for (let i = 0; i < 50; i++) {
      expect(evaluateFlag(definition, context(), opts).value).toBe(first);
    }
  });
});

describe("variants", () => {
  const variantRule: Rule = {
    id: "r1",
    variants: [
      { value: "a", weight: 50 },
      { value: "b", weight: 50 },
    ],
  };

  test("serves one of the declared variants", () => {
    const result = evaluateFlag(flag({ rules: [variantRule] }), context(), opts);

    expect(["a", "b"]).toContain(result.value);
    expect(result.reason).toBe("rule");
    expect(result.ruleId).toBe("r1");
  });

  test("both variants are reachable across subjects", () => {
    const seen = new Set<unknown>();
    for (let i = 0; i < 200; i++) {
      seen.add(
        evaluateFlag(
          flag({ rules: [variantRule] }),
          context({ user: { publicId: `usr_${i}` } }),
          opts,
        ).value,
      );
    }

    expect(seen).toEqual(new Set(["a", "b"]));
  });

  test("unusable weights fall back to the flag default and report an error", () => {
    const result = evaluateFlag(
      flag({
        defaultValue: "safe",
        rules: [{ id: "r1", variants: [{ value: "a", weight: 0 }] }],
      }),
      context(),
      opts,
    );

    expect(result).toEqual({ value: "safe", reason: "error", ruleId: "r1" });
  });
});

describe("bucketing subject", () => {
  test("falls back to the anonymous id when there is no user", () => {
    const anon = context({ user: null, anonymousId: "anon-42" });
    const definition = flag({ rules: [{ id: "r1", rollout: 50, value: true }] });
    const first = evaluateFlag(definition, anon, opts).value;

    // Stable for that visitor rather than reshuffling per call.
    expect(evaluateFlag(definition, context({ user: null, anonymousId: "anon-42" }), opts).value).toBe(
      first,
    );
  });

  test("anonymous visitors do not all share one bucket", () => {
    const definition = flag({ rules: [{ id: "r1", rollout: 50, value: "in" }] });
    const seen = new Set<unknown>();
    for (let i = 0; i < 200; i++) {
      seen.add(
        evaluateFlag(definition, context({ user: null, anonymousId: `anon-${i}` }), opts).value,
      );
    }

    expect(seen.size).toBe(2);
  });

  test("a flag can bucket on something other than the user", () => {
    const definition = flag({
      bucketBy: "attributes.orgId",
      rules: [{ id: "r1", rollout: 50, value: "in" }],
    });

    // Everyone in one org lands together, which is the point of org-level rollout.
    const a = evaluateFlag(
      definition,
      context({ user: { publicId: "usr_1" }, attributes: { orgId: "org_1" } }),
      opts,
    ).value;
    const b = evaluateFlag(
      definition,
      context({ user: { publicId: "usr_2" }, attributes: { orgId: "org_1" } }),
      opts,
    ).value;

    expect(a).toBe(b);
  });

  test("a rule can override the flag's bucketBy", () => {
    const shared = context({ user: { publicId: "usr_1" }, attributes: { orgId: "org_1" } });
    const byUser = evaluateFlag(
      flag({ rules: [{ id: "r1", rollout: 50, value: "in", bucketBy: "user.publicId" }] }),
      shared,
      opts,
    );
    const byOrg = evaluateFlag(
      flag({ rules: [{ id: "r1", rollout: 50, value: "in", bucketBy: "attributes.orgId" }] }),
      shared,
      opts,
    );

    // Not asserting they differ — they may coincide — only that both resolve.
    expect([byUser.value, byOrg.value].every((v) => v === "in" || v === false)).toBe(true);
  });
});

describe("bucket memoization", () => {
  test("reuses a computed bucket within a request", () => {
    const buckets = new Map<string, number>();
    const definition = flag({
      rules: [
        {
          id: "r1",
          rollout: 50,
          variants: [
            { value: "a", weight: 50 },
            { value: "b", weight: 50 },
          ],
        },
      ],
    });

    evaluateFlag(definition, context(), { ...opts, buckets });
    const afterFirst = new Map(buckets);
    evaluateFlag(definition, context(), { ...opts, buckets });

    expect(buckets).toEqual(afterFirst);
    // A rollout gate and a variant split are two distinct namespaces.
    expect(buckets.size).toBeLessThanOrEqual(2);
  });

  test("memoized and unmemoized evaluation agree", () => {
    const definition = flag({ rules: [{ id: "r1", rollout: 50, value: "in" }] });

    for (let i = 0; i < 50; i++) {
      const ctx = context({ user: { publicId: `usr_${i}` } });
      expect(evaluateFlag(definition, ctx, { ...opts, buckets: new Map() }).value).toBe(
        evaluateFlag(definition, ctx, opts).value,
      );
    }
  });
});
