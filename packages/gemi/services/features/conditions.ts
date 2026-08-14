import type { Condition, ConditionOperator, EvaluationContext } from "./types";

/**
 * The context's own top-level fields. A path starting with one of these is
 * resolved against the context; anything else is resolved against
 * `attributes`, so `"plan"` and `"attributes.plan"` mean the same thing.
 *
 * The shorthand exists because app-supplied attributes are what rules mostly
 * target, and making every rule author write the prefix is a papercut applied
 * hundreds of times. The explicit form still works, so a future context field
 * named like somebody's attribute does not silently capture it — the rule can
 * always be disambiguated by writing `attributes.` in full.
 */
const ROOTS = new Set(["user", "attributes", "request", "anonymousId", "now"]);

/**
 * Never traversed. Rule paths come from a `Json` column that an operator edits
 * through an admin UI, so they are untrusted input reaching a property access.
 * Without this, `__proto__.…` walks off the object graph and into the prototype
 * chain, where `constructor` is a function and comparisons against it produce
 * confidently wrong answers.
 */
const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

/** Resolves a dot path, with array indices, against the evaluation context. */
export function attributeAt(ctx: EvaluationContext, path: string): unknown {
  if (typeof path !== "string" || path.length === 0) return undefined;

  const parts = path.split(".").filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;

  let current: unknown = ROOTS.has(parts[0]) ? ctx : ctx.attributes;

  for (const part of parts) {
    if (BLOCKED.has(part)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object" && typeof current !== "string") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asTime(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

/**
 * Applies one operator.
 *
 * Every comparison is **strict**: a mismatch of type is `false`, never a
 * coercion and never a throw. A rule targeting `user.age > 18` against a user
 * whose age is the string `"20"` does not match, and that is deliberate — the
 * alternative is a rule that appears to work until the day the column type
 * changes underneath it.
 */
const OPERATORS: Record<
  ConditionOperator,
  (actual: unknown, expected: unknown) => boolean
> = {
  eq: (actual, expected) => actual === expected,
  neq: (actual, expected) => actual !== expected,

  in: (actual, expected) => {
    if (!Array.isArray(expected)) return false;
    if (Array.isArray(actual)) return actual.some((item) => expected.includes(item));
    return expected.includes(actual);
  },
  nin: (actual, expected) => {
    if (!Array.isArray(expected)) return false;
    if (Array.isArray(actual)) return !actual.some((item) => expected.includes(item));
    return !expected.includes(actual);
  },

  contains: (actual, expected) => {
    if (Array.isArray(actual)) return actual.includes(expected);
    if (typeof actual === "string" && typeof expected === "string") {
      return actual.includes(expected);
    }
    return false;
  },
  ncontains: (actual, expected) => !OPERATORS.contains(actual, expected),

  startsWith: (actual, expected) =>
    typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected),
  endsWith: (actual, expected) =>
    typeof actual === "string" && typeof expected === "string" && actual.endsWith(expected),

  gt: (actual, expected) => {
    const a = asFiniteNumber(actual);
    const b = asFiniteNumber(expected);
    return a !== null && b !== null && a > b;
  },
  gte: (actual, expected) => {
    const a = asFiniteNumber(actual);
    const b = asFiniteNumber(expected);
    return a !== null && b !== null && a >= b;
  },
  lt: (actual, expected) => {
    const a = asFiniteNumber(actual);
    const b = asFiniteNumber(expected);
    return a !== null && b !== null && a < b;
  },
  lte: (actual, expected) => {
    const a = asFiniteNumber(actual);
    const b = asFiniteNumber(expected);
    return a !== null && b !== null && a <= b;
  },

  before: (actual, expected) => {
    const a = asTime(actual);
    const b = asTime(expected);
    return a !== null && b !== null && a < b;
  },
  after: (actual, expected) => {
    const a = asTime(actual);
    const b = asTime(expected);
    return a !== null && b !== null && a > b;
  },

  exists: (actual) => actual !== undefined && actual !== null,
  nexists: (actual) => actual === undefined || actual === null,
};

export function matchCondition(condition: Condition, ctx: EvaluationContext): boolean {
  const operator = OPERATORS[condition?.operator];
  // An unknown operator means a rule written against a newer gemi, or a typo.
  // Refusing to match is the safe direction: it withholds the flag rather than
  // granting it on a condition nobody can evaluate.
  if (!operator) return false;

  return operator(attributeAt(ctx, condition.attribute), condition.value);
}

/**
 * All conditions must hold. An empty or absent list matches everyone — that is
 * the catch-all rule.
 *
 * There is no OR. Two rules serving the same value express it, which keeps the
 * data model flat and every rule independently readable; nested boolean groups
 * in a `Json` column are the thing nobody can debug at 2am.
 */
export function matchAll(
  conditions: Condition[] | undefined,
  ctx: EvaluationContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => matchCondition(condition, ctx));
}

export { OPERATORS };
