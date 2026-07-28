import type { SqlDialect } from "../dialect";
import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import type { ModelSchema } from "../schema";
import { type Fragment, joinFragments, sql } from "./fragment";

// Nothing in an `orderBy` is ever a parameter: a column name comes from the
// schema and a direction is a closed set of two words. Both are structural, so
// both belong in the plan key and neither may come from user input unchecked.

const DIRECTIONS = new Set(["asc", "desc"]);
const NULLS = new Set(["first", "last"]);

export interface OrderTerm {
  column: string;
  direction: "asc" | "desc";
  nulls?: "first" | "last";
}

/**
 * Parses Prisma's three accepted forms into terms:
 * `{ id: "asc" }`, `[{ a: "asc" }, { b: "desc" }]`, and the
 * `{ name: { sort: "asc", nulls: "last" } }` long form.
 */
export function parseOrderBy(
  schema: ModelSchema,
  orderBy: unknown,
  operation: string,
): OrderTerm[] {
  if (orderBy === undefined || orderBy === null) return [];

  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  const terms: OrderTerm[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new UnsupportedQueryError(
        "orderBy",
        schema.name,
        operation,
        "Expected an object or an array of objects.",
      );
    }

    // Insertion order, deliberately unsorted: unlike a `where`, the order of an
    // `orderBy`'s keys is semantic — it is the sort precedence.
    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined) continue;

      if (key in schema.relations) {
        throw new UnsupportedQueryError(
          `orderBy.${key}`,
          schema.name,
          operation,
          "Ordering by a relation is not implemented yet.",
        );
      }

      const field = schema.fields[key];
      if (!field) {
        throw new UnknownFieldError(
          key,
          schema.name,
          Object.keys(schema.fields),
        );
      }

      terms.push({
        column: field.column,
        ...parseDirection(schema, key, value, operation),
      });
    }
  }

  return terms;
}

function parseDirection(
  schema: ModelSchema,
  key: string,
  value: unknown,
  operation: string,
): { direction: "asc" | "desc"; nulls?: "first" | "last" } {
  if (typeof value === "string") {
    if (!DIRECTIONS.has(value)) {
      throw new UnsupportedQueryError(
        `orderBy.${key}: ${JSON.stringify(value)}`,
        schema.name,
        operation,
        'Expected "asc" or "desc".',
      );
    }
    return { direction: value as "asc" | "desc" };
  }

  if (typeof value === "object" && value !== null) {
    const { sort, nulls } = value as Record<string, unknown>;
    const direction = parseDirection(schema, key, sort, operation).direction;

    if (nulls === undefined) return { direction };
    if (typeof nulls !== "string" || !NULLS.has(nulls)) {
      throw new UnsupportedQueryError(
        `orderBy.${key}.nulls: ${JSON.stringify(nulls)}`,
        schema.name,
        operation,
        'Expected "first" or "last".',
      );
    }
    return { direction, nulls: nulls as "first" | "last" };
  }

  throw new UnsupportedQueryError(
    `orderBy.${key}`,
    schema.name,
    operation,
    'Expected "asc", "desc", or { sort, nulls }.',
  );
}

/** Flips every term. This is how Prisma reads a negative `take`. */
export function reverse(terms: OrderTerm[]): OrderTerm[] {
  return terms.map((term) => ({
    ...term,
    direction: term.direction === "asc" ? "desc" : "asc",
    ...(term.nulls
      ? { nulls: term.nulls === "first" ? ("last" as const) : ("first" as const) }
      : {}),
  }));
}

export function compileOrderBy(
  terms: OrderTerm[],
  dialect: SqlDialect,
  /**
   * Prefix for every column — `"User".` — when the statement has a second table
   * in scope. See `WhereContext.qualifier`; absent is the common case and emits
   * byte-identical SQL to what it did before this existed.
   */
  qualifier?: string,
): Fragment | null {
  if (terms.length === 0) return null;

  // `nulls first` / `nulls last` is used directly on both dialects. Prisma
  // emits a `CASE WHEN ... IS NULL` expression on SQLite instead, which dates
  // from before SQLite 3.30 — it has understood the standard syntax since, and
  // Bun bundles 3.51.
  return joinFragments(
    terms.map((term) =>
      sql(
        `${qualifier ?? ""}${dialect.quoteIdent(term.column)} ${term.direction}` +
          (term.nulls ? ` nulls ${term.nulls}` : ""),
      ),
    ),
    ", ",
  );
}
