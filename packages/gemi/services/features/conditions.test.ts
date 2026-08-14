import { describe, expect, test } from "vitest";
import { attributeAt, matchAll, matchCondition } from "./conditions";
import type { Condition, EvaluationContext } from "./types";

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    user: {
      publicId: "usr_1",
      email: "a@example.com",
      globalRole: 1,
      accounts: [{ organizationRole: 0 }],
      tags: ["beta", "internal"],
    },
    attributes: { plan: "pro", seats: 12, since: "2026-01-01T00:00:00.000Z" },
    request: { path: "/pricing", routePath: "/pricing", locale: "en-US" },
    anonymousId: "anon-1",
    now: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

const match = (condition: Condition, ctx = context()) => matchCondition(condition, ctx);

describe("attributeAt", () => {
  const ctx = context();

  test("resolves a context root path", () => {
    expect(attributeAt(ctx, "user.email")).toBe("a@example.com");
    expect(attributeAt(ctx, "request.locale")).toBe("en-US");
    expect(attributeAt(ctx, "anonymousId")).toBe("anon-1");
  });

  test("a bare path resolves against attributes", () => {
    expect(attributeAt(ctx, "plan")).toBe("pro");
    expect(attributeAt(ctx, "attributes.plan")).toBe("pro");
  });

  test("resolves array indices", () => {
    expect(attributeAt(ctx, "user.accounts.0.organizationRole")).toBe(0);
  });

  test("a missing intermediate yields undefined rather than throwing", () => {
    expect(attributeAt(ctx, "user.missing.deeper")).toBeUndefined();
    expect(attributeAt(context({ user: null }), "user.email")).toBeUndefined();
  });

  test("prototype keys are not traversable", () => {
    // Rule paths come from an operator-editable Json column.
    expect(attributeAt(ctx, "__proto__")).toBeUndefined();
    expect(attributeAt(ctx, "user.__proto__.constructor")).toBeUndefined();
    expect(attributeAt(ctx, "user.constructor")).toBeUndefined();
    expect(attributeAt(ctx, "attributes.constructor.name")).toBeUndefined();
  });

  test("an empty or malformed path yields undefined", () => {
    expect(attributeAt(ctx, "")).toBeUndefined();
    expect(attributeAt(ctx, ".")).toBeUndefined();
    expect(attributeAt(ctx, undefined as any)).toBeUndefined();
  });
});

describe("operators", () => {
  test("eq / neq are strict", () => {
    expect(match({ attribute: "plan", operator: "eq", value: "pro" })).toBe(true);
    expect(match({ attribute: "plan", operator: "eq", value: "PRO" })).toBe(false);
    expect(match({ attribute: "seats", operator: "eq", value: "12" })).toBe(false);
    expect(match({ attribute: "plan", operator: "neq", value: "free" })).toBe(true);
  });

  test("in / nin", () => {
    expect(match({ attribute: "plan", operator: "in", value: ["pro", "team"] })).toBe(true);
    expect(match({ attribute: "plan", operator: "in", value: ["free"] })).toBe(false);
    expect(match({ attribute: "plan", operator: "nin", value: ["free"] })).toBe(true);
  });

  test("in treats an array attribute as an intersection", () => {
    expect(match({ attribute: "user.tags", operator: "in", value: ["beta"] })).toBe(true);
    expect(match({ attribute: "user.tags", operator: "in", value: ["nope"] })).toBe(false);
    expect(match({ attribute: "user.tags", operator: "nin", value: ["nope"] })).toBe(true);
  });

  test("in requires an array operand", () => {
    expect(match({ attribute: "plan", operator: "in", value: "pro" })).toBe(false);
  });

  test("contains works on strings and arrays", () => {
    expect(match({ attribute: "user.email", operator: "contains", value: "@example" })).toBe(true);
    expect(match({ attribute: "user.tags", operator: "contains", value: "internal" })).toBe(true);
    expect(match({ attribute: "user.tags", operator: "ncontains", value: "external" })).toBe(true);
    expect(match({ attribute: "seats", operator: "contains", value: 1 })).toBe(false);
  });

  test("startsWith / endsWith are string-only", () => {
    expect(match({ attribute: "user.email", operator: "startsWith", value: "a@" })).toBe(true);
    expect(match({ attribute: "user.email", operator: "endsWith", value: ".com" })).toBe(true);
    expect(match({ attribute: "seats", operator: "startsWith", value: "1" })).toBe(false);
  });

  test("numeric comparisons need finite numbers on both sides", () => {
    expect(match({ attribute: "seats", operator: "gt", value: 10 })).toBe(true);
    expect(match({ attribute: "seats", operator: "gte", value: 12 })).toBe(true);
    expect(match({ attribute: "seats", operator: "lt", value: 12 })).toBe(false);
    expect(match({ attribute: "seats", operator: "lte", value: 12 })).toBe(true);
    // A numeric string is not a number — no coercion.
    expect(match({ attribute: "seats", operator: "gt", value: "10" })).toBe(false);
    expect(match({ attribute: "plan", operator: "gt", value: 1 })).toBe(false);
  });

  test("date comparisons parse both sides", () => {
    expect(match({ attribute: "since", operator: "before", value: "2026-03-01" })).toBe(true);
    expect(match({ attribute: "since", operator: "after", value: "2026-03-01" })).toBe(false);
    expect(match({ attribute: "now", operator: "after", value: "2026-01-01" })).toBe(true);
    expect(match({ attribute: "since", operator: "before", value: "not-a-date" })).toBe(false);
  });

  test("exists / nexists", () => {
    expect(match({ attribute: "plan", operator: "exists" })).toBe(true);
    expect(match({ attribute: "nope", operator: "exists" })).toBe(false);
    expect(match({ attribute: "nope", operator: "nexists" })).toBe(true);
    expect(match({ attribute: "user.email", operator: "nexists" })).toBe(false);
  });

  test("an unknown operator withholds rather than grants", () => {
    expect(match({ attribute: "plan", operator: "regex" as any, value: ".*" })).toBe(false);
    expect(match({ attribute: "plan", operator: undefined as any })).toBe(false);
  });

  test("an anonymous context matches nothing user-targeted, without throwing", () => {
    const anon = context({ user: null });
    expect(matchCondition({ attribute: "user.globalRole", operator: "eq", value: 1 }, anon)).toBe(
      false,
    );
    expect(matchCondition({ attribute: "user.email", operator: "exists" }, anon)).toBe(false);
  });
});

describe("matchAll", () => {
  const ctx = context();

  test("an absent or empty list matches everyone", () => {
    expect(matchAll(undefined, ctx)).toBe(true);
    expect(matchAll([], ctx)).toBe(true);
  });

  test("all conditions must hold", () => {
    expect(
      matchAll(
        [
          { attribute: "plan", operator: "eq", value: "pro" },
          { attribute: "seats", operator: "gt", value: 10 },
        ],
        ctx,
      ),
    ).toBe(true);

    expect(
      matchAll(
        [
          { attribute: "plan", operator: "eq", value: "pro" },
          { attribute: "seats", operator: "gt", value: 100 },
        ],
        ctx,
      ),
    ).toBe(false);
  });
});
