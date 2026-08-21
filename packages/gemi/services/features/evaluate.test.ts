import { describe, expect, test, vi } from "vitest";
import { bucketKey, bucketOf, inRollout } from "./bucket";
import { defineFeature } from "./defineFeature";
import { evaluateFeature, subjectFor } from "./evaluate";
import type { FeatureContext } from "./types";

function context(overrides: Partial<FeatureContext> = {}): FeatureContext {
  return {
    user: null,
    attributes: {},
    request: { path: null, routePath: null, locale: null },
    anonymousId: null,
    isBot: false,
    now: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** The exact bucket a subject lands in, so a test can pick one either side. */
function bucketFor(key: string, subject: string) {
  return bucketOf(bucketKey(key, subject));
}

/** A rollout percentage that definitely includes / excludes this subject. */
function rolloutIncluding(key: string, subject: string) {
  return bucketFor(key, subject) / 100 + 0.01;
}
function rolloutExcluding(key: string, subject: string) {
  return bucketFor(key, subject) / 100;
}

describe("the switch short-circuits everything", () => {
  test("no row is off", () => {
    const feature = defineFeature();
    expect(evaluateFeature("f", feature, context(), { active: undefined })).toEqual({
      value: false,
      reason: "inactive",
    });
  });

  test("active: false is off", () => {
    const feature = defineFeature();
    expect(evaluateFeature("f", feature, context(), { active: false })).toEqual({
      value: false,
      reason: "inactive",
    });
  });

  test("a `when` that would say yes cannot defeat the kill switch", () => {
    const feature = defineFeature({ when: () => true });
    expect(evaluateFeature("f", feature, context(), { active: false }).value).toBe(false);
  });

  test("a 100% rollout cannot defeat the kill switch", () => {
    const feature = defineFeature({ rollout: 100 });
    expect(evaluateFeature("f", feature, context(), { active: false }).value).toBe(false);
  });
});

describe("an unreachable store fails closed", () => {
  test("unavailable is off even when the feature would be on for everyone", () => {
    const feature = defineFeature();
    expect(
      evaluateFeature("f", feature, context(), {
        active: true,
        unavailable: true,
      }),
    ).toEqual({ value: false, reason: "unavailable" });
  });
});

describe("switched on", () => {
  test("no `when` and no `rollout` is on for everyone", () => {
    expect(evaluateFeature("f", defineFeature(), context(), { active: true })).toEqual({
      value: true,
      reason: "on",
    });
  });

  test("`when` returning true wins", () => {
    const feature = defineFeature({ when: () => true, rollout: 0 });
    expect(evaluateFeature("f", feature, context(), { active: true })).toEqual({
      value: true,
      reason: "attributed",
    });
  });

  test("`when` returning false wins over a 100% rollout", () => {
    const feature = defineFeature({ when: () => false, rollout: 100 });
    expect(evaluateFeature("f", feature, context(), { active: true })).toEqual({
      value: false,
      reason: "attributed",
    });
  });

  test("`when` returning nothing abstains and the rollout decides", () => {
    const feature = defineFeature({ when: () => undefined, rollout: 100 });
    expect(evaluateFeature("f", feature, context(), { active: true })).toEqual({
      value: true,
      reason: "rollout",
    });
  });

  test("`when` reads the context", () => {
    const feature = defineFeature({
      when: (ctx) => ctx.user?.plan === "enterprise",
    });
    const enterprise = context({ user: { plan: "enterprise" } });
    const free = context({ user: { plan: "free" } });

    expect(evaluateFeature("f", feature, enterprise, { active: true }).value).toBe(true);
    expect(evaluateFeature("f", feature, free, { active: true }).value).toBe(false);
  });

  test("rollout 0 excludes everyone", () => {
    const feature = defineFeature({ rollout: 0 });
    const ctx = context({ anonymousId: "visitor-1" });
    expect(evaluateFeature("f", feature, ctx, { active: true })).toEqual({
      value: false,
      reason: "excluded",
    });
  });
});

describe("bucketing", () => {
  test("the same subject gets the same answer every time", () => {
    const feature = defineFeature({ rollout: 50 });
    const ctx = context({ anonymousId: "visitor-1" });

    const first = evaluateFeature("f", feature, ctx, { active: true }).value;
    for (let i = 0; i < 20; i++) {
      expect(evaluateFeature("f", feature, ctx, { active: true }).value).toBe(first);
    }
  });

  test("raising a rollout only ever adds subjects", () => {
    // The property that makes ramping safe: nobody who had the feature loses it.
    const subjects = Array.from({ length: 300 }, (_, i) => `visitor-${i}`);
    let previous = new Set<string>();

    for (const percent of [0, 5, 10, 25, 50, 75, 100]) {
      const feature = defineFeature({ rollout: percent });
      const included = new Set(
        subjects.filter(
          (id) =>
            evaluateFeature("f", feature, context({ anonymousId: id }), {
              active: true,
            }).value,
        ),
      );

      for (const id of previous) {
        expect(included.has(id), `${id} lost the feature at ${percent}%`).toBe(true);
      }
      previous = included;
    }

    expect(previous.size).toBe(subjects.length);
  });

  test("two features at the same percentage select different subjects", () => {
    // Salting by key is what decorrelates them. Without it, a subject unlucky in
    // one 20% rollout would be unlucky in every other 20% rollout.
    const subjects = Array.from({ length: 500 }, (_, i) => `visitor-${i}`);
    const feature = defineFeature({ rollout: 20 });

    const inA = subjects.filter(
      (id) =>
        evaluateFeature("a", feature, context({ anonymousId: id }), {
          active: true,
        }).value,
    );
    const inB = subjects.filter(
      (id) =>
        evaluateFeature("b", feature, context({ anonymousId: id }), {
          active: true,
        }).value,
    );

    expect(inA).not.toEqual(inB);
    // Overlap should be about 20% of 20% — nowhere near identical.
    const overlap = inA.filter((id) => inB.includes(id)).length;
    expect(overlap).toBeLessThan(inA.length * 0.6);
  });

  test("a shared salt holds two features on the same population", () => {
    const subjects = Array.from({ length: 200 }, (_, i) => `visitor-${i}`);
    const a = defineFeature({ rollout: 30, salt: "shared" });
    const b = defineFeature({ rollout: 30, salt: "shared" });

    for (const id of subjects) {
      const ctx = context({ anonymousId: id });
      expect(evaluateFeature("a", a, ctx, { active: true }).value).toBe(
        evaluateFeature("b", b, ctx, { active: true }).value,
      );
    }
  });

  test("the rollout lands within a percent or so of the target", () => {
    const subjects = Array.from({ length: 4000 }, (_, i) => `visitor-${i}`);
    const feature = defineFeature({ rollout: 25 });

    const included = subjects.filter(
      (id) =>
        evaluateFeature("f", feature, context({ anonymousId: id }), {
          active: true,
        }).value,
    ).length;

    expect(included / subjects.length).toBeGreaterThan(0.22);
    expect(included / subjects.length).toBeLessThan(0.28);
  });

  test("memoises the bucket across reads", () => {
    const buckets = new Map<string, number>();
    const feature = defineFeature({ rollout: 50 });
    const ctx = context({ anonymousId: "visitor-1" });

    evaluateFeature("f", feature, ctx, { active: true, buckets });
    evaluateFeature("f", feature, ctx, { active: true, buckets });

    expect(buckets.size).toBe(1);
    expect(buckets.get(bucketKey("f", "visitor-1"))).toBe(bucketFor("f", "visitor-1"));
  });
});

describe("the subject", () => {
  test("prefers the user over the anonymous id", () => {
    expect(subjectFor(context({ user: { publicId: "u1" }, anonymousId: "a1" }))).toBe("u1");
  });

  test("falls back to id when there is no publicId", () => {
    expect(subjectFor(context({ user: { id: 7 } }))).toBe("7");
  });

  test("falls back to the session cookie for a logged-out visitor", () => {
    expect(subjectFor(context({ anonymousId: "a1" }))).toBe("a1");
  });

  test("is the empty string outside a request", () => {
    expect(subjectFor(context())).toBe("");
  });

  test("a user is bucketed the same on every device", () => {
    const feature = defineFeature({ rollout: 50 });
    const laptop = context({
      user: { publicId: "u1" },
      anonymousId: "device-a",
    });
    const phone = context({
      user: { publicId: "u1" },
      anonymousId: "device-b",
    });

    expect(evaluateFeature("f", feature, laptop, { active: true }).value).toBe(
      evaluateFeature("f", feature, phone, { active: true }).value,
    );
  });
});

describe("crawlers", () => {
  test("are pinned off for a rollout", () => {
    const feature = defineFeature({ rollout: 100 });
    const ctx = context({ isBot: true, anonymousId: "crawler" });
    expect(evaluateFeature("f", feature, ctx, { active: true })).toEqual({
      value: false,
      reason: "bot",
    });
  });

  test("still see a feature that is on for everyone", () => {
    // No rollout means no sampling, so there is nothing to be inconsistent
    // about across crawls — a bot should see what every visitor sees.
    const feature = defineFeature();
    const ctx = context({ isBot: true });
    expect(evaluateFeature("f", feature, ctx, { active: true }).value).toBe(true);
  });

  test("a `when` still wins over the bot guard", () => {
    const feature = defineFeature({ when: () => true, rollout: 10 });
    const ctx = context({ isBot: true });
    expect(evaluateFeature("f", feature, ctx, { active: true }).value).toBe(true);
  });
});

describe("rollout boundaries", () => {
  test("a subject just inside is on, just outside is off", () => {
    const subject = "visitor-42";
    const ctx = context({ anonymousId: subject });

    const on = defineFeature({ rollout: rolloutIncluding("f", subject) });
    const off = defineFeature({ rollout: rolloutExcluding("f", subject) });

    expect(evaluateFeature("f", on, ctx, { active: true }).value).toBe(true);
    expect(evaluateFeature("f", off, ctx, { active: true }).value).toBe(false);
  });

  test("inRollout is a `<` test", () => {
    expect(inRollout(0, 0)).toBe(false);
    expect(inRollout(0, 100)).toBe(true);
    expect(inRollout(9999, 100)).toBe(true);
    expect(inRollout(5000, 50)).toBe(false);
    expect(inRollout(4999, 50)).toBe(true);
  });
});

describe("a throwing `when`", () => {
  test("reads off rather than escaping into the render", () => {
    // The overwhelmingly common shape of this bug: no `?.`, and every anonymous
    // page load throws.
    const feature = defineFeature({
      when: (ctx) => (ctx.user as any).plan === "pro",
      rollout: 100,
    });
    const warn = vi.fn();

    expect(evaluateFeature("f", feature, context(), { active: true, warn })).toEqual({
      value: false,
      reason: "error",
    });
    expect(warn.mock.calls.flat().join(" ")).toMatch(/"f"/);
  });

  test("does not fall through to the rollout", () => {
    // Abstaining would ship the feature to a slice of users nobody approved.
    const feature = defineFeature({
      when: () => {
        throw new Error("boom");
      },
      rollout: 100,
    });

    expect(evaluateFeature("f", feature, context(), { active: true }).value).toBe(false);
  });
});

describe("declaration validation", () => {
  test("rejects a rollout outside 0-100", () => {
    expect(() => defineFeature({ rollout: -1 })).toThrow(/between 0 and 100/);
    expect(() => defineFeature({ rollout: 101 })).toThrow(/between 0 and 100/);
    expect(() => defineFeature({ rollout: Number.NaN })).toThrow(/between 0 and 100/);
  });

  test("accepts the boundaries", () => {
    expect(defineFeature({ rollout: 0 }).rollout).toBe(0);
    expect(defineFeature({ rollout: 100 }).rollout).toBe(100);
  });
});
