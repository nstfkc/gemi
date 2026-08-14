import type { FeatureFlag } from "../../http/FeatureRouter";
import { OPERATORS } from "./conditions";
import type {
  Condition,
  FeatureFlagDefinition,
  FlagValue,
  Rule,
  VariantWeight,
} from "./types";

export type Warn = (message: string) => void;

/**
 * Turns a database row into something the evaluator can trust.
 *
 * `rules` is a `Json` column. Nothing in the database enforces its shape, and
 * the thing writing it is an admin UI or a psql session — so by the time it
 * reaches here it may be a string, an object, an array of nulls, or a rule
 * naming an operator that does not exist. Every one of those has to produce a
 * *degraded* flag and a log line, never a throw: this code runs inside the
 * render path of every page, and a `TypeError` here takes the site down for a
 * mistake somebody made in a form field.
 *
 * The bias throughout is to drop the smallest thing that is broken and keep
 * going, except where dropping would *widen* a flag's audience — see the
 * variant handling below.
 */
export function normalizeFlag(
  row: Record<string, unknown>,
  declared: FeatureFlag<FlagValue>,
  warn: Warn = () => {},
): FeatureFlagDefinition | null {
  const key = typeof row?.key === "string" ? row.key : null;
  if (!key) {
    warn("Ignoring a FeatureFlag row with no `key`.");
    return null;
  }

  return {
    key,
    enabled: row.enabled === true,
    // `null` in either column means "not configured", which is the declaration's
    // cue rather than a literal null. A flag whose declared default is `null`
    // is indistinguishable, and that is fine: both mean the same value.
    offValue: coerceValue(row.offValue, declared.defaultValue),
    defaultValue: coerceValue(row.defaultValue, declared.defaultValue),
    rules: normalizeRules(row.rules, key, declared, warn),
    seed: typeof row.seed === "string" && row.seed.length > 0 ? row.seed : key,
    bucketBy: typeof row.bucketBy === "string" && row.bucketBy.length > 0 ? row.bucketBy : null,
    // From the code declaration only. A row must not be able to make a flag
    // public that the application declared server-only — that would let a
    // database write leak the existence of an unannounced feature.
    serverOnly: declared.isServerOnly,
  };
}

function coerceValue(raw: unknown, fallback: FlagValue): FlagValue {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean" || typeof raw === "number" || typeof raw === "string") {
    return raw;
  }
  // An object or array in a value column is a flag being used as a config
  // store. Refusing it keeps the payload flat and the type honest.
  return fallback;
}

export function normalizeRules(
  raw: unknown,
  flagKey: string,
  declared: FeatureFlag<FlagValue>,
  warn: Warn = () => {},
): Rule[] {
  const parsed = parseJsonColumn(raw);
  if (parsed === undefined) return [];

  if (!Array.isArray(parsed)) {
    warn(`Feature flag "${flagKey}": \`rules\` is not an array; ignoring all rules.`);
    return [];
  }

  const rules: Rule[] = [];
  parsed.forEach((entry, index) => {
    const rule = normalizeRule(entry, index, flagKey, declared, warn);
    if (rule) rules.push(rule);
  });
  return rules;
}

/**
 * Some drivers hand back a parsed object for a `Json` column and some hand back
 * the raw string. Accepting both means the same row behaves identically on
 * SQLite and Postgres.
 */
function parseJsonColumn(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeRule(
  entry: unknown,
  index: number,
  flagKey: string,
  declared: FeatureFlag<FlagValue>,
  warn: Warn,
): Rule | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    warn(`Feature flag "${flagKey}": rule at index ${index} is not an object; skipping.`);
    return null;
  }

  const source = entry as Record<string, unknown>;
  const hasBucketing =
    source.rollout !== undefined ||
    (Array.isArray(source.variants) && source.variants.length > 0);

  let id = typeof source.id === "string" && source.id.length > 0 ? source.id : null;
  if (!id) {
    id = `rule-${index}`;
    if (hasBucketing) {
      // The id salts the bucket, so an index-derived one re-buckets everyone
      // the moment a rule above it is inserted or removed — silently, mid
      // rollout. Worth saying out loud rather than absorbing.
      warn(
        `Feature flag "${flagKey}": rule at index ${index} has a rollout or variants but no \`id\`, so its bucketing is tied to its position. Reordering the rules will re-bucket every user. Give it a stable \`id\`.`,
      );
    }
  }

  const conditions = normalizeConditions(source.conditions, flagKey, id, warn);
  if (conditions === null) return null;

  const segments = Array.isArray(source.segments)
    ? source.segments.filter((value): value is string => typeof value === "string")
    : undefined;

  const rollout = normalizeRollout(source.rollout, flagKey, id, warn);
  if (rollout === null) return null;

  const variants = normalizeVariants(source.variants, flagKey, id, declared, warn);
  if (variants === null) return null;

  const rule: Rule = { id, conditions, segments, rollout };

  if (variants) {
    rule.variants = variants;
  } else if (source.value !== undefined) {
    const value = coerceValue(source.value, null);
    if (!isAllowed(value, declared)) {
      warn(
        `Feature flag "${flagKey}": rule "${id}" serves ${JSON.stringify(value)}, which is not one of the declared values; skipping the rule.`,
      );
      return null;
    }
    rule.value = value;
  }

  if (typeof source.bucketBy === "string" && source.bucketBy.length > 0) {
    rule.bucketBy = source.bucketBy;
  }

  return rule;
}

/** `null` means the rule is unusable; `undefined` means it has no conditions. */
function normalizeConditions(
  raw: unknown,
  flagKey: string,
  ruleId: string,
  warn: Warn,
): Condition[] | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    warn(`Feature flag "${flagKey}": rule "${ruleId}" has non-array \`conditions\`; skipping.`);
    return null;
  }

  const conditions: Condition[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      warn(`Feature flag "${flagKey}": rule "${ruleId}" has a malformed condition; skipping.`);
      return null;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.attribute !== "string" || typeof candidate.operator !== "string") {
      warn(`Feature flag "${flagKey}": rule "${ruleId}" has a condition missing \`attribute\` or \`operator\`; skipping.`);
      return null;
    }
    if (!(candidate.operator in OPERATORS)) {
      // Dropping just this condition would *widen* the rule — the remaining
      // conditions are ANDed, so removing one lets more people through. The
      // whole rule goes instead.
      warn(`Feature flag "${flagKey}": rule "${ruleId}" uses unknown operator "${candidate.operator}"; skipping.`);
      return null;
    }
    conditions.push({
      attribute: candidate.attribute,
      operator: candidate.operator as Condition["operator"],
      value: candidate.value,
    });
  }

  return conditions;
}

function normalizeRollout(
  raw: unknown,
  flagKey: string,
  ruleId: string,
  warn: Warn,
): number | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warn(`Feature flag "${flagKey}": rule "${ruleId}" has a non-numeric \`rollout\`; skipping.`);
    return null;
  }
  // Clamped rather than refused: 120 unambiguously means "everyone" and -5
  // means "nobody", and neither is worth discarding a rule over.
  return Math.min(100, Math.max(0, raw));
}

function normalizeVariants(
  raw: unknown,
  flagKey: string,
  ruleId: string,
  declared: FeatureFlag<FlagValue>,
  warn: Warn,
): VariantWeight[] | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    warn(`Feature flag "${flagKey}": rule "${ruleId}" has malformed \`variants\`; skipping.`);
    return null;
  }

  const variants: VariantWeight[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      warn(`Feature flag "${flagKey}": rule "${ruleId}" has a malformed variant; skipping.`);
      return null;
    }
    const candidate = entry as Record<string, unknown>;
    const weight = typeof candidate.weight === "number" ? candidate.weight : Number.NaN;
    if (!Number.isFinite(weight) || weight < 0) {
      warn(`Feature flag "${flagKey}": rule "${ruleId}" has a variant with an invalid weight; skipping.`);
      return null;
    }
    const value = coerceValue(candidate.value, null);
    if (!isAllowed(value, declared)) {
      // Dropping one variant silently redistributes its share across the
      // others, which changes the experiment for everyone rather than only for
      // the broken arm. The rule goes as a unit.
      warn(
        `Feature flag "${flagKey}": rule "${ruleId}" has variant ${JSON.stringify(value)}, which is not one of the declared values; skipping the rule.`,
      );
      return null;
    }
    variants.push({ value, weight });
  }

  return variants;
}

/** `variant()` flags declare a closed set; everything else accepts any value. */
function isAllowed(value: FlagValue, declared: FeatureFlag<FlagValue>): boolean {
  if (!declared.allowed) return true;
  return declared.allowed.includes(value);
}
