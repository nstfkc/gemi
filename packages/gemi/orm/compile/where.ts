import type { SqlDialect } from "../dialect";
import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import type { ModelSchema } from "../schema";
import { concat, type Fragment, joinFragments, param, sql } from "./fragment";

/** Prisma's boolean combinators. Compiled in iteration 2. */
const COMBINATORS = new Set(["AND", "OR", "NOT"]);

/**
 * Compiles a `where` object into a boolean expression.
 *
 * Iteration 1 handles exactly one thing: scalar equality, with multiple keys
 * `AND`ed. Everything else — operators, combinators, relation filters — throws
 * `UnsupportedQueryError` naming the offending key. Signatures accept the full
 * Prisma argument type from day one and capability grows underneath them, so
 * failing loudly on the gap is the whole contract.
 *
 * Returns `null` when the object contributes no predicate at all, so the caller
 * can omit the `where` clause rather than emit `where 1 = 1`.
 */
export function compileWhere(
  schema: ModelSchema,
  where: unknown,
  dialect: SqlDialect,
  operation: string,
  /**
   * Re-locates this same `where` object inside the argument tree at bind time.
   * Compilation reads the object it was handed; binding has to find it again in
   * whatever the caller passes. Explicit rather than assuming `args.where`, so
   * the nested `where`s inside an `include` tree can reuse this unchanged.
   */
  locate: (args: any) => any = (args) => args?.where,
): Fragment | null {
  if (where === undefined || where === null) return null;

  if (typeof where !== "object" || Array.isArray(where)) {
    throw new UnsupportedQueryError(
      "where",
      schema.name,
      operation,
      "Expected an object.",
    );
  }

  const predicates: Fragment[] = [];

  // Sorted, not insertion-ordered: the plan cache canonicalises key order when
  // it builds the cache key, so two argument objects that differ only in key
  // order share one entry — and must therefore compile to the same SQL text.
  const keys = Object.keys(where as Record<string, unknown>).sort();

  for (const key of keys) {
    const value = (where as Record<string, unknown>)[key];
    // Prisma treats an explicit `undefined` as "not provided". Matching that
    // matters: it is how conditional filters are written in application code.
    if (value === undefined) continue;

    if (COMBINATORS.has(key)) {
      throw new UnsupportedQueryError(key, schema.name, operation);
    }

    if (key in schema.relations) {
      throw new UnsupportedQueryError(
        key,
        schema.name,
        operation,
        "Filtering on a relation is not implemented yet.",
      );
    }

    const field = schema.fields[key];
    if (!field) {
      throw new UnknownFieldError(key, schema.name, Object.keys(schema.fields));
    }

    if (value === null) {
      // `= ?` with a null parameter matches nothing in SQL, whereas Prisma
      // means `is null`. Emitting the former would silently return the wrong
      // rows, so refuse until iteration 2 implements null equality properly.
      throw new UnsupportedQueryError(
        `where.${key}: null`,
        schema.name,
        operation,
        "Null equality is not implemented yet.",
      );
    }

    if (typeof value === "object" && !(value instanceof Date)) {
      const operator = Object.keys(value as Record<string, unknown>)[0];
      throw new UnsupportedQueryError(
        operator ? `where.${key}.${operator}` : `where.${key}`,
        schema.name,
        operation,
        "Only scalar equality is implemented yet.",
      );
    }

    predicates.push(
      concat(
        // The identifier comes from `schema.fields`, never from `key` itself.
        // That lookup is the entire injection story for identifiers; values
        // are always parameters, which is the other half.
        sql(`${dialect.quoteIdent(field.column)} = `),
        // Closes over the *path*, not the value — so the same shape with
        // different values reuses this plan and only `bind` differs. Which
        // encoder runs is fixed at compile time from the field's schema; only
        // the value it is applied to comes from the call.
        param((args) => dialect.encode(locate(args)?.[key], field)),
      ),
    );
  }

  if (predicates.length === 0) return null;
  return joinFragments(predicates, " and ");
}
