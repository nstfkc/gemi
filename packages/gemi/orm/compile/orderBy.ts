import type { SqlDialect } from "../dialect";
import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import type { ModelSchema } from "../schema";
import { type Fragment, joinFragments, sql } from "./fragment";
import { relationOrderExpression } from "./order-relation";

// Nothing in an `orderBy` is ever a parameter: a column name comes from the
// schema and a direction is a closed set of two words. Both are structural, so
// both belong in the plan key and neither may come from user input unchecked.

const DIRECTIONS = new Set(["asc", "desc"]);
const NULLS = new Set(["first", "last"]);

export interface OrderTerm {
  column: string;
  direction: "asc" | "desc";
  nulls?: "first" | "last";
  /**
   * A compiled expression to order by, instead of the column.
   *
   * Present only for a relation ordering — `orderBy: { organization: { name:
   * "asc" } }` — which is a correlated subquery rather than a column, and the
   * first ordering term that can carry a *parameter* (the scope a policy put on
   * the related model). `column` stays populated as a label so the term is still
   * readable in a debugger and so `reverse()` needs no special case.
   */
  expression?: Fragment;
}

/**
 * What a relation ordering needs that a column ordering does not: a dialect to
 * quote with, and the path back into the argument tree for the scope's binders.
 *
 * Optional, and absent means relation orderings are refused with the message
 * they had before. The only caller that omits it is one compiling a *child*
 * query inside a strategy, where the relation would be a third level and the
 * planner has not been asked for one.
 */
export interface OrderContext {
  dialect: SqlDialect;
  /** Re-locates this `orderBy` inside the arguments at bind time. */
  locate: (args: any) => any;
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
  context?: OrderContext,
): OrderTerm[] {
  if (orderBy === undefined || orderBy === null) return [];

  const array = Array.isArray(orderBy);
  const entries = array ? orderBy : [orderBy];
  const terms: OrderTerm[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    /**
     * Where *this* entry sits, for a relation ordering's binders.
     *
     * The array form has to be indexed and the object form must not be — and
     * this is a place where getting it wrong is silent, because a scope's
     * parameters would simply bind `undefined` and the ordering would still
     * produce SQL.
     */
    const entryAt = (args: any) => {
      const found = context?.locate(args);
      return array ? found?.[index] : found;
    };
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
        if (!context) {
          throw new UnsupportedQueryError(
            `orderBy.${key}`,
            schema.name,
            operation,
            "Ordering by a relation is not implemented here.",
          );
        }

        const ordered = relationOrderExpression(
          schema,
          schema.relations[key],
          value,
          operation,
          context.dialect,
          (args: any) => entryAt(args)?.[key],
          terms.length,
        );

        terms.push({
          column: key,
          direction: ordered.direction,
          ...(ordered.nulls ? { nulls: ordered.nulls } : {}),
          expression: ordered.expression,
        });
        continue;
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
    terms.map((term) => {
      const suffix =
        ` ${term.direction}` + (term.nulls ? ` nulls ${term.nulls}` : "");

      // A relation ordering brings its own expression — and its own parameters,
      // which is why this is a `Fragment` rather than a string.
      if (term.expression) {
        return joinFragments([term.expression, sql(suffix)], "");
      }

      return sql(
        `${qualifier ?? ""}${dialect.quoteIdent(term.column)}${suffix}`,
      );
    }),
    ", ",
  );
}
