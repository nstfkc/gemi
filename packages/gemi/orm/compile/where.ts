import type { SqlDialect } from "../dialect";
import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import type { FieldSchema, ModelSchema } from "../schema";
import {
  type Binder,
  type Fragment,
  concat,
  joinFragments,
  param,
  sql,
} from "./fragment";

/**
 * `where` -> a boolean expression, recursively.
 *
 * The shape here is the thing every later iteration extends, so it is worth
 * stating: this is a recursive function over the argument tree returning
 * `Fragment`s, with binders carrying paths into that tree. It is never string
 * concatenation with a parameter counter in an outer scope, and it never
 * branches on the dialect's *name* — where the dialects genuinely differ in
 * structure (`in`, `like`), the work is delegated to the dialect interface.
 *
 * Semantics are Prisma's, verified by running Prisma against SQLite and reading
 * the SQL it emits rather than by reasoning about the docs:
 *
 * | Prisma                  | SQL                        |
 * | ---                     | ---                        |
 * | `{ f: null }`           | `f is null`                |
 * | `{ f: { equals: null }}`| `f is null`                |
 * | `{ f: { not: null } }`  | `f is not null`            |
 * | `{ f: { not: v } }`     | `f <> ?`                   |
 * | `{ f: { in: [] } }`     | `false`                    |
 * | `{ AND: [] }`           | `true`                     |
 * | `{ OR: [] }`            | `false`                    |
 * | `{ NOT: { a, b } }`     | `not (a = ? and b = ?)`    |
 *
 * Returns `null` when the object contributes no predicate at all, so the caller
 * can omit the clause rather than emit `where true`.
 */
export function compileWhere(
  schema: ModelSchema,
  where: unknown,
  context: WhereContext,
  /**
   * Re-locates this same object inside the argument tree at bind time.
   * Compilation reads the object it was handed; binding has to find it again in
   * whatever the caller passes. Explicit rather than assuming `args.where`, so
   * the nested `where`s inside an `include` tree can reuse this unchanged.
   */
  locate: (args: any) => any,
): Fragment | null {
  if (where === undefined || where === null) return null;

  if (typeof where !== "object" || Array.isArray(where)) {
    throw new UnsupportedQueryError(
      "where",
      schema.name,
      context.operation,
      "Expected an object.",
    );
  }

  const predicates: Fragment[] = [];

  // Sorted, not insertion-ordered: the plan cache canonicalises key order when
  // it builds the cache key, so two argument objects that differ only in key
  // order share one entry — and must therefore compile to the same SQL text.
  for (const key of Object.keys(where as Record<string, unknown>).sort()) {
    const value = (where as Record<string, unknown>)[key];
    // Prisma treats an explicit `undefined` as "not provided". Matching that
    // matters: it is how conditional filters are written in application code.
    if (value === undefined) continue;

    const at = (args: any) => locate(args)?.[key];

    if (key === "AND" || key === "OR") {
      const combined = compileGroup(schema, value, context, at, key);
      if (combined) predicates.push(combined);
      continue;
    }

    if (key === "NOT") {
      const negated = compileGroup(schema, value, context, at, "AND");
      // `NOT` of nothing is vacuously true, so it contributes no predicate.
      // The operand is always parenthesised: `not a = ?` happens to parse the
      // way we mean on both dialects, but relying on `not` binding looser than
      // every comparison it might wrap is not a property worth depending on.
      if (negated) predicates.push(concat(sql("not "), parenthesize(negated)));
      continue;
    }

    if (key in schema.relations) {
      throw new UnsupportedQueryError(
        key,
        schema.name,
        context.operation,
        "Filtering on a relation is not implemented yet.",
      );
    }

    const field = schema.fields[key];
    if (!field) {
      throw new UnknownFieldError(key, schema.name, Object.keys(schema.fields));
    }

    predicates.push(compileFieldFilter(schema, field, value, context, at));
  }

  if (predicates.length === 0) return null;
  if (predicates.length === 1) return predicates[0];
  return group(predicates, " and ");
}

export interface WhereContext {
  dialect: SqlDialect;
  operation: string;
}

/** `AND` / `OR`, accepting Prisma's array form and its single-object form. */
function compileGroup(
  schema: ModelSchema,
  value: unknown,
  context: WhereContext,
  locate: (args: any) => any,
  joiner: "AND" | "OR",
): Fragment | null {
  const parts: Fragment[] = [];

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const compiled = compileWhere(
        schema,
        value[i],
        context,
        (args) => locate(args)?.[i],
      );
      if (compiled) parts.push(compiled);
    }
  } else {
    const compiled = compileWhere(schema, value, context, locate);
    if (compiled) parts.push(compiled);
  }

  if (parts.length === 0) {
    // Prisma: an empty `AND` is vacuously true and contributes nothing; an empty
    // `OR` matches nothing at all. Verified against the SQL Prisma emits — it
    // produces `1=1` and `1=0` respectively.
    return joiner === "AND" ? null : FALSE;
  }
  if (parts.length === 1) return parts[0];
  return group(parts, joiner === "AND" ? " and " : " or ");
}

/**
 * Boolean literals rather than `1=0` (which is what Prisma emits): they carry
 * the same meaning on both dialects and keep the invariant that no digit ever
 * reaches the SQL text outside an identifier, which is an actual test.
 */
const FALSE: Fragment = sql("false");

function group(parts: Fragment[], separator: string): Fragment {
  return concat(sql("("), joinFragments(parts, separator), sql(")"));
}

/**
 * Wraps a fragment in parentheses unless it already is one. `group` is the only
 * thing that emits a leading `(`, and it always closes it, so the check is
 * exact — and it keeps `not (...)` from stuttering into `not ((...))`.
 */
function parenthesize(fragment: Fragment): Fragment {
  return fragment.text.startsWith("(") ? fragment : group([fragment], "");
}

/** Every operator Prisma allows on a scalar field. */
const OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "mode",
]);

const COMPARISONS: Record<string, string> = {
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

function compileFieldFilter(
  schema: ModelSchema,
  field: FieldSchema,
  value: unknown,
  context: WhereContext,
  locate: (args: any) => any,
): Fragment {
  const { dialect } = context;
  const column = dialect.quoteIdent(field.column);

  // A bare value is shorthand for `equals`. A `Date` is a value, not a filter
  // object, even though `typeof` cannot tell them apart.
  if (!isFilterObject(value)) {
    return equals(column, field, value, dialect, locate);
  }

  const filter = value as Record<string, unknown>;
  const keys = Object.keys(filter).sort();

  // Prisma-only, and only meaningful next to a string operator. Read here so it
  // does not get treated as an operator in its own right.
  const insensitive = filter.mode === "insensitive";
  if (filter.mode !== undefined && filter.mode !== "default") {
    if (!insensitive) {
      throw new UnsupportedQueryError(
        `mode: ${JSON.stringify(filter.mode)}`,
        schema.name,
        context.operation,
      );
    }
    if (!dialect.supportsInsensitiveMode) {
      throw new UnsupportedQueryError(
        "mode: \"insensitive\"",
        schema.name,
        context.operation,
        `The ${dialect.name} dialect cannot express it — Prisma rejects it ` +
          `here too. Note SQLite's LIKE is already case-insensitive for ASCII.`,
      );
    }
  }

  const parts: Fragment[] = [];

  for (const key of keys) {
    const operand = filter[key];
    if (operand === undefined || key === "mode") continue;

    if (!OPERATORS.has(key)) {
      throw new UnsupportedQueryError(
        `where.${field.name}.${key}`,
        schema.name,
        context.operation,
      );
    }

    const at = (args: any) => locate(args)?.[key];

    switch (key) {
      case "equals":
        parts.push(equals(column, field, operand, dialect, at));
        break;

      case "not":
        parts.push(
          compileNot(schema, field, operand, context, at, column),
        );
        break;

      case "in":
      case "notIn":
        parts.push(
          inList(schema, column, field, operand, context, at, key === "notIn"),
        );
        break;

      case "lt":
      case "lte":
      case "gt":
      case "gte":
        parts.push(
          concat(
            sql(`${column} ${COMPARISONS[key]} `),
            param(encoded(field, dialect, at)),
          ),
        );
        break;

      case "contains":
      case "startsWith":
      case "endsWith":
        parts.push(
          dialect.like(column, insensitive, likePattern(key, at)),
        );
        break;
    }
  }

  if (parts.length === 0) return sql("true");
  if (parts.length === 1) return parts[0];
  return group(parts, " and ");
}

/** `not` is a whole nested filter, not just a value — `not: { in: [...] }`. */
function compileNot(
  schema: ModelSchema,
  field: FieldSchema,
  operand: unknown,
  context: WhereContext,
  locate: (args: any) => any,
  column: string,
): Fragment {
  if (operand === null) return sql(`${column} is not null`);

  if (!isFilterObject(operand)) {
    return concat(
      sql(`${column} <> `),
      param(encoded(field, context.dialect, locate)),
    );
  }

  // `not: { in: [...] }` and the rest compile to `not (<positive form>)`.
  // Prisma emits `not in` directly, which is a different *text* but the same
  // predicate: both yield NULL — and so exclude the row — when the column is
  // NULL. The contract is equal results, not equal SQL.
  const inner = compileFieldFilter(schema, field, operand, context, locate);
  return concat(sql("not "), parenthesize(inner));
}

function equals(
  column: string,
  field: FieldSchema,
  operand: unknown,
  dialect: SqlDialect,
  locate: (args: any) => any,
): Fragment {
  // `= ?` with a null parameter matches nothing in SQL, where Prisma means
  // `is null`. This is the difference that would silently return wrong rows.
  if (operand === null) return sql(`${column} is null`);
  return concat(sql(`${column} = `), param(encoded(field, dialect, locate)));
}

function inList(
  schema: ModelSchema,
  column: string,
  field: FieldSchema,
  operand: unknown,
  context: WhereContext,
  locate: (args: any) => any,
  negated: boolean,
): Fragment {
  const { dialect } = context;

  if (!Array.isArray(operand)) {
    throw new UnsupportedQueryError(
      `where.${field.name}.${negated ? "notIn" : "in"}`,
      schema.name,
      context.operation,
      "Expected an array.",
    );
  }

  // `x in ()` is a syntax error, and Prisma emits a constant-false predicate
  // for it. `not in ()` is vacuously true by the same logic.
  if (operand.length === 0) return negated ? sql("true") : FALSE;

  return dialect.inList(column, negated, operand.length, (args) => {
    const values = locate(args) as unknown[];
    return values.map((value) => dialect.encode(value, field));
  });
}

/**
 * Prisma does **not** escape `%` or `_` inside the value — verified by reading
 * the parameters it binds: `contains: "50%_x"` binds `"%50%_x%"`. So a user
 * string containing a wildcard really does act as a wildcard.
 *
 * That is a footgun, but the contract this ORM signs is differential equality
 * with Prisma, and escaping here would break it on every such query. Matching
 * Prisma and saying so is the honest option; diverging quietly is not.
 */
function likePattern(
  operator: "contains" | "startsWith" | "endsWith",
  locate: (args: any) => any,
): Binder {
  return (args) => {
    const value = String(locate(args));
    if (operator === "contains") return `%${value}%`;
    if (operator === "startsWith") return `${value}%`;
    return `%${value}`;
  };
}

function encoded(
  field: FieldSchema,
  dialect: SqlDialect,
  locate: (args: any) => any,
): Binder {
  return (args) => dialect.encode(locate(args), field);
}

/**
 * True for `{ contains: ... }`, false for a plain value. A `Date` is a value
 * even though it is an object, and so is a `Uint8Array` for a `Bytes` column.
 */
function isFilterObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !ArrayBuffer.isView(value)
  );
}
