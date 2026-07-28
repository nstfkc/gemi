import type { SqlDialect } from "../dialect";
import {
  MalformedRelationError,
  UnknownFieldError,
  UnsupportedQueryError,
} from "../errors";
import {
  isOperatorForm,
  relationFilterOperators,
} from "../relation-filters";
import type { FieldSchema, ModelSchema, RelationSchema } from "../schema";
import { type Correlated, correlate } from "./correlate";
import { uniqueKeys } from "./unique";
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
      const filter = compileRelationFilter(
        schema,
        schema.relations[key],
        value,
        context,
        at,
      );
      if (filter) predicates.push(filter);
      continue;
    }

    const field = schema.fields[key];
    if (!field) {
      // Prisma exposes a composite `@@unique([a, b])` as one key named `a_b`,
      // holding an object of its members. It is the only `where` key that is
      // not a field, a relation or a combinator, and `findUnique` on a model
      // like the template's `SocialAccount` cannot be expressed without it.
      const compound = compileCompoundKey(schema, key, value, context, at);
      if (compound) {
        predicates.push(compound);
        continue;
      }
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
  /**
   * Prefix for every column this `where` names — `"User".` — set only when the
   * statement has more than one table in scope.
   *
   * That happens when a relation strategy folds children in with a lateral join
   * (iteration 9): the subquery introduces a second scope and a bare `"id"`
   * becomes ambiguous. It is the table's own name rather than an invented alias,
   * because Postgres lets a lateral subquery reference the outer table by name.
   *
   * Absent otherwise, and absence is the common case — so a query with no folded
   * relation emits byte-identical SQL to what it did before this existed, which
   * is what keeps invariant 2 and every compiler text assertion untouched.
   */
  qualifier?: string;
  /**
   * How many relation-filter subqueries enclose this one. Zero at the root.
   *
   * It exists only to name the child alias — `_r0`, `_r1` — and the aliases only
   * have to be distinct from the ones *enclosing* them, not from their siblings:
   * each `exists (…)` is its own scope, so two relation filters at the same level
   * cannot see each other. Depth is therefore sufficient, and it keeps the SQL
   * text a pure function of the argument shape, which a counter threaded through
   * compilation would not be.
   */
  relationDepth?: number;
}

/**
 * `where: { accounts: { some: { … } } }` -> `exists (select 1 from "Account" …)`.
 *
 * A correlated subquery rather than a join, for the reason iteration 3 gave when
 * it deferred this: a join against a to-many multiplies the parent rows and then
 * needs a `distinct` to put them back, which changes the row count of the outer
 * query for a filter that should only ever *remove* rows. `exists` cannot.
 *
 * ### The child is always aliased
 *
 * Even when the tables differ and nothing is ambiguous. A self-relation —
 * `Employee.manager` — puts the same table on both sides, and there the
 * subquery's own `from` shadows the outer one, so the correlation silently
 * compares a row to itself. Aliasing conditionally would mean the dangerous case
 * is the one that takes the rarely-exercised branch; aliasing always means the
 * self-relation is compiled by the same code as everything else.
 *
 * The outer side is qualified by table name (or by the enclosing alias, when this
 * filter is itself nested), which is what makes the correlation refer outwards.
 * That needs nothing from the outer statement — `from "User"` puts `"User"` in
 * scope as a qualifier whether or not any other column uses one — so a query with
 * a relation filter leaves the rest of its SQL byte-identical.
 */
function compileRelationFilter(
  schema: ModelSchema,
  relation: RelationSchema,
  value: unknown,
  context: WhereContext,
  locate: (args: any) => any,
): Fragment | null {
  const path = `where.${relation.name}`;

  // Shape before environment: `readOperators` only reads the relation's own
  // `kind`, so a malformed filter is reported as one even when the registry is
  // empty. The other order let a missing `register` call mask a plain typo.
  const operators = relationFilterOperators(relation.kind);
  const requested = readOperators(schema, relation, value, operators, context);

  const depth = context.relationDepth ?? 0;

  const dialect = context.dialect;
  // At depth 0 the outer scope is the queried table; deeper, it is the alias of
  // the subquery this one sits inside. `context.qualifier` already holds the
  // right answer in both cases when something set it — the lateral strategy does
  // at the root — so it wins, and the table name is the fallback.
  const parentQualifier =
    context.qualifier ?? `${dialect.quoteIdent(schema.table)}.`;

  const source = correlate(
    schema,
    relation,
    dialect,
    `_r${depth}`,
    parentQualifier,
  );
  const child = source.child;
  const correlation = sql(source.correlation);

  const inner: WhereContext = {
    ...context,
    qualifier: source.qualifier,
    relationDepth: depth + 1,
  };

  const parts: Fragment[] = [];

  for (const operator of operators) {
    if (!(operator in requested)) continue;

    const argument = requested[operator];
    const at = (args: any) => requested.direct ? locate(args) : locate(args)?.[operator];

    // `is: null` / a bare `null` on a to-one: "there is no related row". Prisma
    // spells the opposite `isNot: null`.
    if (argument === null) {
      parts.push(existence(source, correlation, null, operator === "is"));
      continue;
    }

    const condition = compileWhere(child, argument, inner, at);

    if (operator === "every") {
      // `every` is "no child fails it", not "some child passes it" — the two
      // differ on a parent with no children at all, which `every` matches and
      // `some` does not. An empty `every: {}` therefore constrains nothing.
      if (!condition) continue;
      parts.push(
        existence(
          source,
          correlation,
          concat(sql("not "), parenthesize(condition)),
          true,
        ),
      );
      continue;
    }

    const negate = operator === "none" || operator === "isNot";
    parts.push(existence(source, correlation, condition, negate));
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return group(parts, " and ");
}

/** `exists (select 1 from "Child" as "_r0" where <correlation> [and <rest>])`. */
function existence(
  source: Correlated,
  correlation: Fragment,
  rest: Fragment | null,
  negated: boolean,
): Fragment {
  const parts: Fragment[] = [
    sql(`${negated ? "not " : ""}exists (select 1 from ${source.source} where `),
    correlation,
  ];

  if (rest) parts.push(sql(" and "), rest);
  parts.push(sql(")"));

  return concat(...parts);
}

/**
 * Which operators a relation filter asked for, with Prisma's shorthands folded
 * into the same shape.
 *
 * A to-one accepts the filter directly — `where: { user: { email } }` means
 * `is` — and accepts `null` for "no related row". A to-many does not: Prisma
 * requires one of `some` / `every` / `none`, because a bare object there has no
 * unambiguous reading.
 */
function readOperators(
  schema: ModelSchema,
  relation: RelationSchema,
  value: unknown,
  operators: readonly string[],
  context: WhereContext,
): Record<string, unknown> & { direct?: boolean } {
  const path = `where.${relation.name}`;
  const many = relation.kind === "many";

  if (value === null) {
    if (many) {
      throw new UnsupportedQueryError(
        path,
        schema.name,
        context.operation,
        `${relation.name} is a to-many relation, so null is not a filter for ` +
          `it. Use { none: {} } for "has no related rows".`,
      );
    }
    return { is: null, direct: true };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UnsupportedQueryError(
      path,
      schema.name,
      context.operation,
      many
        ? `Expected an object holding ${operators.join(", ")}.`
        : `Expected an object, or null.`,
    );
  }

  if (isOperatorForm(value as object, operators)) {
    return value as Record<string, unknown>;
  }

  if (many) {
    throw new UnsupportedQueryError(
      path,
      schema.name,
      context.operation,
      `Expected one of ${operators.join(", ")}. A to-many relation has no ` +
        `single reading of a bare filter — { some: … } and { every: … } mean ` +
        `different things.`,
    );
  }

  // The to-one shorthand. Marked so the binder path stays on the object the
  // caller wrote rather than descending into an `is` key that is not there.
  return { is: value, direct: true };
}


/**
 * `{ username_provider: { username, provider } }` -> `username = ? and
 * provider = ?`.
 *
 * Returns `null` when `key` names no declared composite unique, so the caller
 * can fall through to reporting an unknown field.
 */
function compileCompoundKey(
  schema: ModelSchema,
  key: string,
  value: unknown,
  context: WhereContext,
  locate: (args: any) => any,
): Fragment | null {
  // `uniqueKeys`, not `schema.uniques` — the primary key is a unique key, and a
  // compound `@@id` lives only in `schema.primaryKey`. Searching `uniques`
  // alone made the two halves of this disagree: `matchUniqueKey` accepted
  // `tenantId_code` (it asks `uniqueKeys`, which includes the primary key), so
  // the operation compiled, and then this returned `null` and the caller
  // reported an unknown field. Both spellings failed and each error pointed at
  // the other.
  //
  // Invisible until now because the template's only compound key is
  // `SocialAccount`'s `@@unique([username, provider])`. A compound `@@id` — a
  // join table, or any tenant-scoped `@@id([tenantId, id])` — was unreachable
  // by key at all.
  const members = uniqueKeys(schema).find(
    (group) => group.length > 1 && group.join("_") === key,
  );
  if (!members) return null;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnsupportedQueryError(
      `where.${key}`,
      schema.name,
      context.operation,
      `Expected an object holding ${members.join(" and ")}.`,
    );
  }

  const supplied = value as Record<string, unknown>;
  const parts: Fragment[] = [];

  for (const member of members) {
    // Every member is required: a composite key is only unique as a whole, so
    // a partial one would quietly become a non-unique lookup.
    if (supplied[member] === undefined) {
      throw new UnsupportedQueryError(
        `where.${key}`,
        schema.name,
        context.operation,
        `Missing '${member}'. A composite key needs all of ${members.join(", ")}.`,
      );
    }

    parts.push(
      compileFieldFilter(
        schema,
        schema.fields[member],
        supplied[member],
        context,
        (args) => locate(args)?.[member],
      ),
    );
  }

  return parts.length === 1 ? parts[0] : group(parts, " and ");
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
  const column = `${context.qualifier ?? ""}${dialect.quoteIdent(field.column)}`;

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
        // Prisma raises "Argument `contains` must not be null" — verified.
        // Without this, `String(null)` makes the pattern `%null%`, which is a
        // query that runs and returns the wrong rows. The types catch the
        // static case but not a value that arrives dynamically.
        if (typeof operand !== "string") {
          throw new UnsupportedQueryError(
            `where.${field.name}.${key}`,
            schema.name,
            context.operation,
            `Expected a string, received ${operand === null ? "null" : typeof operand}.`,
          );
        }
        if (field.type !== "String") {
          throw new UnsupportedQueryError(
            `where.${field.name}.${key}`,
            schema.name,
            context.operation,
            `'${field.name}' is a ${field.type}, and ${key} only applies to strings.`,
          );
        }
        parts.push(dialect.like(column, insensitive, likePattern(key, at)));
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
