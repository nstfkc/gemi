import type { SqlDialect } from "../dialect";
import {
  InvalidArgumentError,
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
import { JSON_NULL, type JsonNullKind, jsonNullKind } from "../json-null";
import { fieldParam } from "./cast";

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
    throw new InvalidArgumentError(
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

    if (key === COMPOSITE_IN) {
      predicates.push(compileCompositeIn(schema, value, context, at));
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
    context.operation,
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
    throw new InvalidArgumentError(
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
    throw new InvalidArgumentError(
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

/**
 * The internal key a batched relation loader uses to match a **tuple** of
 * columns against a list of tuples — the composite-relation counterpart of
 * `in`, and the reason #97 exists.
 *
 * **`$`-prefixed because a Prisma field cannot be.** Field names match
 * `[A-Za-z][A-Za-z0-9_]*`, so this cannot collide with a column, which a
 * `__`-prefixed name could not promise.
 *
 * It is not part of the public argument grammar, and that is **enforced rather
 * than asserted**. This branch sits above the field lookup, so a caller writing
 * the key by hand used to be honoured — not an injection, since the fields are
 * resolved against the schema and the values are bound, but an undocumented
 * input surface with none of the operand validation its neighbours have. The
 * operand now has to carry {@link PLANNER}, a module-private `Symbol` an
 * application cannot reach, exactly as `markPreScoped` and `markOrmAuthored`
 * gate their own claims.
 */
export const COMPOSITE_IN = "$compositeIn";

/**
 * Marks a composite-`in` operand as the planner's own.
 *
 * A `Symbol`, so it is invisible to `Object.entries` — which means it does not
 * reach the plan key, where it would be noise, and cannot be written in JSON by
 * a caller who has seen the key name in a stack trace.
 */
const PLANNER = Symbol("gemi.orm.compositeInFromPlanner");

/** `{ fields: ["a", "b"], values: [[1, "x"], [2, "y"]] }`. */
interface CompositeInOperand {
  fields: string[];
  values: unknown[][];
}

export function plannerCompositeIn(
  fields: string[],
  values: unknown[][],
): Record<string, unknown> {
  return { [PLANNER]: true, fields, values };
}

/**
 * `(a, b) in (…)`, in whichever form the dialect can bind.
 *
 * Only ever reached on a dialect whose `canBindCompositeIn` said yes for these
 * column types — `plan-relations.ts` asks before it emits this key, and keeps
 * the portable `OR` of `AND`s otherwise. So there is no fallback here: arriving
 * with a dialect that cannot express it is a bug in that decision, not a shape
 * to degrade.
 */
function compileCompositeIn(
  schema: ModelSchema,
  operand: unknown,
  context: WhereContext,
  locate: (args: any) => any,
): Fragment {
  const { dialect } = context;
  const fields = assertCompositeInOperand(schema, operand, context);

  const resolved = fields.map((name) => {
    const field = schema.fields[name];
    if (!field) {
      throw new UnknownFieldError(name, schema.name, Object.keys(schema.fields));
    }
    return field;
  });

  const columns = resolved.map(
    (field) =>
      `${context.qualifier ?? ""}${dialect.quoteIdent(field.column)}`,
  );

  return dialect.compositeIn(
    columns,
    resolved.map((field) => field.type),
    (args) => (locate(args) as CompositeInOperand).values,
  );
}

/**
 * The operand's shape, checked at **plan** time.
 *
 * Every other operand in this file is validated here rather than left to fail
 * at bind time — `assertCreateManyOperand`'s note says why: a refusal that
 * arrives later has to unwind work that should never have started. This one
 * was the exception, and it showed: `{ $compositeIn: null }` raised a raw
 * `TypeError` from a destructure, and `{ fields: ["id"] }` with no `values` at
 * all compiled clean and deferred its failure to bind time.
 */
function assertCompositeInOperand(
  schema: ModelSchema,
  operand: unknown,
  context: WhereContext,
): string[] {
  /**
   * A caller's key gets the **unknown-key treatment**, which is what the
   * original comment promised and what every other key it is not a field for
   * already gets. `UnsupportedQueryError` would render "does not support
   * '$compositeIn' *yet*" — a promise about a key that is deliberately not in
   * the grammar and never will be. That word has now been corrected once each
   * on #82 and #88; this is the third time it has been raised, which is enough
   * to stop treating it as a wording nit and use the error that is simply
   * accurate: `$compositeIn` is not a field on this model.
   */
  const notAField = (): never => {
    throw new UnknownFieldError(
      COMPOSITE_IN,
      schema.name,
      Object.keys(schema.fields),
    );
  };

  if (typeof operand !== "object" || operand === null || Array.isArray(operand)) {
    return notAField();
  }

  if ((operand as Record<symbol, unknown>)[PLANNER] !== true) {
    return notAField();
  }

  /**
   * Below here the operand *is* the planner's, so a bad shape is this ORM's bug
   * rather than a caller's — and `UnsupportedQueryError` is the right class for
   * it: an internal invariant that does not hold is genuinely something the
   * ORM does not support, and "yet" is the honest word for a state it should
   * not be in.
   */
  const refuse = (detail: string): never => {
    throw new UnsupportedQueryError(
      COMPOSITE_IN,
      schema.name,
      context.operation,
      detail,
    );
  };

  const { fields, values } = operand as CompositeInOperand;

  // Below here the operand *is* the planner's, so these are its bugs rather
  // than a caller's — worth catching at compile time for the same reason, and
  // worth a different sentence because the audience is different.
  if (!Array.isArray(fields) || fields.length === 0) {
    return refuse(`the planner built a '${COMPOSITE_IN}' with no fields.`);
  }
  if (!fields.every((name) => typeof name === "string")) {
    return refuse(`the planner built a '${COMPOSITE_IN}' with a non-string field.`);
  }
  if (!Array.isArray(values)) {
    return refuse(`the planner built a '${COMPOSITE_IN}' with no values.`);
  }
  if (!values.every((tuple) => Array.isArray(tuple) && tuple.length === fields.length)) {
    return refuse(
      `the planner built a '${COMPOSITE_IN}' whose tuples do not all have ` +
        `${fields.length} value(s).`,
    );
  }

  return fields;
}

/**
 * The filters Prisma applies to a **scalar list** — `tags String[]`.
 *
 * A different set on a different left-hand side, which is why it is a branch
 * rather than four more entries in `OPERATORS`: `contains` on a `String` asks
 * about a substring, and on a `String[]` there is no such question — the one
 * Prisma spells is `has`. Sharing the table would have made every scalar
 * operator compile against an array column and answer something.
 *
 * A tuple for the same reason {@link JSON_FILTER_NAMES} is one: `ListFilter` in
 * `../types` said in a comment that it mirrors this list, and a comment is not
 * something the compiler checks.
 */
const LIST_FILTER_NAMES = [
  "equals",
  "has",
  "hasEvery",
  "hasSome",
  "isEmpty",
] as const;

/** One of {@link LIST_FILTER_NAMES}. `ListFilter` maps over this. */
export type ListFilterName = (typeof LIST_FILTER_NAMES)[number];

const LIST_FILTERS: ReadonlySet<string> = new Set(LIST_FILTER_NAMES);

/**
 * `where: { tags: { has: "urgent" } }`.
 *
 * **The dialect answers first**, before any operand is looked at, because on
 * SQLite the answer is "not this column, on this database, ever" rather than
 * "not this filter". That refusal used to live in the generator (#300) and
 * could not stay there: the generated artifact is dialect-agnostic on purpose,
 * so refusing a scalar list at generation refused it for Postgres too — and
 * refused the *whole artifact*, since one `String[]` anywhere threw before any
 * model was emitted.
 */
function compileListFilter(
  schema: ModelSchema,
  field: FieldSchema,
  column: string,
  value: unknown,
  context: WhereContext,
  locate: (args: any) => any,
): Fragment {
  const { dialect } = context;
  assertListDialect(schema, field, `where.${field.name}`, context.operation, dialect);

  // **A bare array is not shorthand for `equals` here**, and that is the one
  // place a list deliberately reads differently from a scalar — where
  // `{ email: "a@b" }` means `equals`, `{ tags: ["a"] }` means nothing.
  //
  // Not a judgement call: Prisma refuses it, measured against a generated 6.19
  // client — *"Argument `strings`: Invalid value provided. Expected
  // StringNullableListFilter, provided (String)."* Accepting it would make gemi
  // a silent superset of Prisma on the one dialect where a differential test
  // could otherwise check every other answer, which is the trade this project
  // has declined every time it has come up.
  //
  // The asymmetry that surprises: the same bare array *is* accepted as a
  // **write** value — `data: { tags: ["a"] }` is valid Prisma and valid here.
  // Filter and value are different positions and Prisma treats them
  // differently; so does this.
  if (Array.isArray(value)) {
    throw new InvalidArgumentError(
      `where.${field.name}`,
      schema.name,
      context.operation,
      `'${field.name}' is a scalar list, and a bare array is not a filter on ` +
        `one — Prisma rejects it here too. Say which comparison you mean: ` +
        `{ ${field.name}: { equals: [...] } } for the whole list, or ` +
        `{ ${field.name}: { hasEvery: [...] } } for "contains all of these". ` +
        `A bare array *is* accepted as a value in \`data\`.`,
    );
  }

  if (!isFilterObject(value)) {
    throw new InvalidArgumentError(
      `where.${field.name}`,
      schema.name,
      context.operation,
      `'${field.name}' is a scalar list. Expected an object holding ` +
        `${[...LIST_FILTERS].sort().join(", ")}; received ` +
        `${value === null ? "null" : typeof value}.`,
    );
  }

  const filter = value as Record<string, unknown>;
  const parts: Fragment[] = [];

  // Sorted, for the reason `compileWhere` sorts: the plan cache canonicalises
  // key order, so two objects differing only in it must compile alike.
  for (const key of Object.keys(filter).sort()) {
    const operand = filter[key];
    if (operand === undefined) continue;

    if (!LIST_FILTERS.has(key)) {
      throw new InvalidArgumentError(
        `where.${field.name}.${key}`,
        schema.name,
        context.operation,
        `'${field.name}' is a scalar list, and a list filter takes ` +
          `${[...LIST_FILTERS].sort().join(", ")}. The scalar operators — ` +
          `${[...OPERATORS].sort().join(", ")} — apply to a single value and ` +
          `Prisma does not offer them here.`,
      );
    }

    const at = (args: any) => locate(args)?.[key];
    parts.push(listComparison(schema, field, column, key, operand, context, at));
  }

  // An empty filter object constrains nothing, which is what the scalar path
  // does with `{}` too.
  if (parts.length === 0) return sql("true");
  if (parts.length === 1) return parts[0];
  return group(parts, " and ");
}

/** One list filter key. */
function listComparison(
  schema: ModelSchema,
  field: FieldSchema,
  column: string,
  key: string,
  operand: unknown,
  context: WhereContext,
  locate: (args: any) => any,
): Fragment {
  const { dialect } = context;

  if (key === "equals") {
    return listEquals(schema, field, column, operand, context, locate);
  }

  if (key === "isEmpty") {
    if (typeof operand !== "boolean") {
      throw new InvalidArgumentError(
        `where.${field.name}.isEmpty`,
        schema.name,
        context.operation,
        `Expected true or false, received ${operand === null ? "null" : typeof operand}.`,
      );
    }
    return dialect.listIsEmpty(column, operand);
  }

  if (key === "has") {
    // One **element**, so it binds as one — through the element's own field, so
    // a `Json[]` gets #209's `::text::jsonb` on the placeholder and the
    // serialisation that has to travel with it. Binding it as a list instead
    // would produce an array literal on the left of `= any(...)`, and binding
    // it with no cast answers *false* on a `Json[]` rather than raising.
    const element = elementOf(field);
    return dialect.listHas(
      column,
      fieldParam(element, dialect, encoded(element, dialect, locate)),
    );
  }

  // `hasEvery` / `hasSome` — both take a list, and both have a defined answer
  // for an empty one: `@> '{}'` is true of every row and `&& '{}'` of none,
  // which is what Prisma means by "contains all of nothing" and "shares one
  // element with nothing".
  if (!Array.isArray(operand)) {
    throw new InvalidArgumentError(
      `where.${field.name}.${key}`,
      schema.name,
      context.operation,
      `Expected an array, received ${operand === null ? "null" : typeof operand}.`,
    );
  }

  const values = fieldParam(field, dialect, encoded(field, dialect, locate));
  return key === "hasEvery"
    ? dialect.listHasEvery(column, values)
    : dialect.listHasSome(column, values);
}

/** `"tags" = $1` — whole-list equality, which is order-sensitive in SQL. */
function listEquals(
  schema: ModelSchema,
  field: FieldSchema,
  column: string,
  operand: unknown,
  context: WhereContext,
  locate: (args: any) => any,
): Fragment {
  const { dialect } = context;

  // A list column cannot be null in Prisma — `String[]?` is refused at schema
  // validation — but `equals: null` is still in the generated filter type, and
  // a column written by something other than Prisma can hold NULL. Same
  // reading as everywhere else: `= NULL` matches nothing, `is null` is meant.
  if (operand === null) return sql(`${column} is null`);

  if (!Array.isArray(operand)) {
    throw new InvalidArgumentError(
      `where.${field.name}.equals`,
      schema.name,
      context.operation,
      `'${field.name}' is a scalar list, so it compares against an array. ` +
        `Received ${typeof operand}. For "is this element present", use ` +
        `{ ${field.name}: { has: … } }.`,
    );
  }

  return concat(
    sql(`${column} = `),
    fieldParam(field, dialect, encoded(field, dialect, locate)),
  );
}

/**
 * The same field, seen as **one element of itself**.
 *
 * `type` already carries the element type — that is the whole reason `isList`
 * is a flag beside it rather than a `ScalarType` constructor — so dropping the
 * flag is the entire conversion, and `encode`, `decode` and `castParameter` all
 * read it as the scalar they were written for.
 */
function elementOf(field: FieldSchema): FieldSchema {
  return { ...field, isList: false };
}

/**
 * Refuses a scalar list on a dialect that has no array type, naming it.
 *
 * Shared by the read and write paths, and it says more than "unsupported"
 * because the reader's likeliest next question is whether they did something
 * wrong. They did not: Prisma refuses the *column* on SQLite, so a schema that
 * declares one was generated against Postgres and this process is pointed at a
 * database that could not hold it either.
 */
export function assertListDialect(
  schema: ModelSchema,
  field: FieldSchema,
  argument: string,
  operation: string,
  dialect: SqlDialect,
): void {
  if (dialect.listFilters.size > 0) return;

  throw new UnsupportedQueryError(
    argument,
    schema.name,
    operation,
    `'${field.name}' is a scalar list, and ${dialect.name} has no array type ` +
      `to hold one. Prisma refuses the column itself on ${dialect.name} — ` +
      `"the current connector does not support lists of primitive types" — so ` +
      `this is a difference between the databases rather than a gap in the ` +
      `ORM. The generated artifact is dialect-agnostic, which is why this ` +
      `surfaces here rather than at \`prisma generate\`: the schema was ` +
      `generated against Postgres and DATABASE_URL names a ${dialect.name} ` +
      `database, which has no '${field.column}' column either. It works on ` +
      `postgres.`,
  );
}

/**
 * The filters Prisma applies to a value extracted from a JSON path.
 *
 * **A tuple, and the caller-facing type is a mapped type over it.**
 * `JsonPathFilter` in `../types` used to spell these ten names a second time,
 * in a file that neither imports this one nor is imported by it, so the two
 * lists could differ with no compile error, no failing test and no diff a
 * reviewer would flag. That is the mechanism behind #326, #333, #336 and #337 —
 * the compiler accepting something the type refuses to describe — and #336 was
 * the worst of them because the undescribed filter was silently absorbed as an
 * `equals` shorthand rather than refused.
 *
 * Deriving the type from this list makes the drift a compile error at the call
 * sites instead of something the next reviewer has to notice.
 */
const JSON_FILTER_NAMES = [
  "equals",
  "not",
  "string_contains",
  "string_starts_with",
  "string_ends_with",
  "array_contains",
  "lt",
  "lte",
  "gt",
  "gte",
] as const;

/** One of {@link JSON_FILTER_NAMES}. `JsonPathFilter` maps over this. */
export type JsonFilterName = (typeof JSON_FILTER_NAMES)[number];

const JSON_FILTERS: ReadonlySet<string> = new Set(JSON_FILTER_NAMES);

/**
 * `where: { metadata: { path: …, equals: … } }`.
 *
 * **Two dialects, two path grammars, and that is Prisma's split rather than
 * this ORM's.** Measured on both through a generated client: Postgres takes
 * `path: ["a", "b"]` and refuses a string; SQLite takes `path: "$.a.b"` and
 * refuses an array. So the argument is dialect-specific before it arrives here,
 * and `jsonPathSyntax` is what lets the check say which form *this* database
 * wants instead of failing inside the driver.
 *
 * **The path is bound, never interpolated.** This is the one place a caller's
 * value decides part of an expression's meaning, which makes it the obvious
 * place to break invariant 2 by accident. Neither dialect needs it in the text:
 * Postgres's `#>` takes a `text[]` parameter and SQLite's `json_extract` takes
 * a string, so the whole feature fits inside the existing rule.
 *
 * The operator set is the dialect's too. Prisma refuses `array_contains` and
 * the numeric comparisons on SQLite — *"Unknown argument"* — so refusing them
 * here is matching it, not falling short: implementing them would make gemi
 * answer a query the oracle cannot, which is precisely where a differential
 * test stops being able to check anything.
 */
function compileJsonFilter(
  schema: ModelSchema,
  field: FieldSchema,
  column: string,
  filter: Record<string, unknown>,
  context: WhereContext,
  locate: (args: any) => any,
): Fragment {
  const { dialect } = context;

  if (field.type !== "Json") {
    throw new UnsupportedQueryError(
      `${field.name}.path`,
      schema.name,
      context.operation,
      `A 'path' filter reads inside a JSON document, and '${field.name}' is ` +
        `a ${field.type} column.`,
    );
  }

  assertPathShape(schema, field, filter.path, context);

  const path: Binder = (args) => locate(args)?.path;
  // **An `undefined` operand is an absent one**, which is the rule the scalar
  // operator loop already follows (`if (operand === undefined …) continue`) and
  // the rule the dispatch above follows for `path` itself
  // (`filter.path !== undefined`). Building `applied` from `Object.keys` alone
  // made this branch the one place that broke it: a filter assembled from a
  // form or a query string carries `equals: undefined` for the field nobody
  // filled in, and that compiled to `= NULL` — a predicate no row can satisfy —
  // where the same query with the key simply omitted got the bare-path refusal
  // below.
  //
  // Prisma answers both spellings identically. Measured on a generated 6.19.2
  // client against Postgres: `{ path: ["a"], equals: undefined }` and
  // `{ path: ["a"] }` both raise P2019 *"A JSON path cannot be set without a
  // scalar filter."*, and `{ path: ["a"], equals: 1, gt: undefined }` compiles
  // the `equals` alone.
  //
  // **This is also what makes the plan cache safe here**, which is the stronger
  // reason and the one a reader will otherwise have to re-derive.
  // `canonicalShape` drops `undefined` members, so the two spellings were
  // already *one* cache key — measured:
  //
  //     planKey(postgres, "User", "findMany", { where: { metadata: { path: ["a"] } } })
  //     planKey(postgres, "User", "findMany", { where: { metadata: { path: ["a"], equals: undefined } } })
  //       both -> postgres:batched:User:findMany:{where:{metadata:{path:[string]}}}
  //
  // while they compiled to two different things, a refusal and a `= NULL` plan.
  // Whichever compiled first decided for the other, so a bare `path` arriving
  // second was served the never-true plan instead of the refusal it raises
  // cold. Both throw now, so there is nothing left for the shared key to
  // collide on.
  const applied = Object.keys(filter)
    .filter((key) => key !== "path" && filter[key] !== undefined)
    .sort();

  if (applied.length === 0) {
    // Prisma: "A JSON path cannot be set without a scalar filter." Reproduced
    // because the alternative is an extraction with nothing to compare it to,
    // which compiles to a value in a predicate position on one dialect and to
    // an error on the other.
    throw new UnsupportedQueryError(
      `${field.name}.path`,
      schema.name,
      context.operation,
      `A 'path' needs a filter beside it — ${[...JSON_FILTERS].sort().join(", ")}. ` +
        `Prisma refuses a bare path too.`,
    );
  }

  const parts: Fragment[] = [];

  for (const key of applied) {
    if (!JSON_FILTERS.has(key)) {
      throw new UnsupportedQueryError(
        `${field.name}.${key}`,
        schema.name,
        context.operation,
        `A JSON path filter takes ${[...JSON_FILTERS].sort().join(", ")}.`,
      );
    }

    if (!dialect.jsonFilters.has(key)) {
      throw new UnsupportedQueryError(
        `${field.name}.${key}`,
        schema.name,
        context.operation,
        `'${key}' on a JSON path is not available on ${dialect.name}. Prisma ` +
          `refuses it here too, so this is a difference between the databases ` +
          `rather than a gap in the ORM. It works on postgres.`,
      );
    }

    const operand = filter[key];

    // **The sentinels have to be refused here, and only here.**
    //
    // `compileFieldFilter` refuses a bare sentinel above this branch, and
    // refuses `AnyNull` under a non-`equals`/`not` operator in the scalar key
    // loop below it. A `path` filter sits between the two and reaches neither,
    // so before this check a sentinel inside a JSON filter went straight to the
    // binder: Postgres compared against the literal text `Prisma.DbNull` and
    // SQLite bound the sentinel object. Zero rows, no error — the failure class
    // #259 and #266 exist to close, arrived at from the one direction nothing
    // was watching.
    //
    // Refused rather than mapped. The scalar path *can* answer these because it
    // compiles them against the column, where SQL NULL and the JSON value
    // `null` are distinguishable. An extracted value has already lost that
    // distinction — `#>>` yields NULL both for an absent key and for a JSON
    // null — so answering here would mean picking one meaning and being
    // silently wrong about the other.
    const sentinel = jsonNullKind(operand);
    if (sentinel) {
      throw new InvalidArgumentError(
        `where.${field.name}.${key}`,
        schema.name,
        context.operation,
        `${sentinelName(sentinel)} is not a filter on an extracted JSON ` +
          `value: the extraction yields NULL for an absent key and for a JSON ` +
          `null alike, so the distinction the sentinel exists to make is ` +
          `already gone. Filter the column itself — ` +
          `{ ${field.name}: { equals: ${sentinelName(sentinel)} } } — or test ` +
          `the path against the value you mean.`,
      );
    }

    // The same shape one level down: `{ path: …, equals: { not: DbNull } }`.
    if (carriesAnyNull(operand)) {
      throw new InvalidArgumentError(
        `where.${field.name}.${key}`,
        schema.name,
        context.operation,
        `Prisma.AnyNull cannot be reached through a JSON path, for the same ` +
          `reason the other two cannot: the extracted value does not ` +
          `distinguish an absent key from a JSON null.`,
      );
    }

    assertJsonOperand(key, operand, schema, field, context);

    parts.push(
      jsonComparison(key, column, path, field, dialect, (args) =>
        locate(args)?.[key],
      ),
    );
  }

  return parts.length === 1
    ? parts[0]
    : group(parts, " and ");
}

/**
 * What each JSON filter will accept as its operand.
 *
 * Three defects, all of them the shape the scalar path is already careful about
 * and all silent:
 *
 *   - **The string filters had no non-string guard.** Their scalar siblings
 *     refuse one, with a comment explaining that `String(null)` makes the
 *     pattern `%null%` — "a query that runs and returns the wrong rows".
 *     `string_contains: null` compiled to `like NULL`, which matches nothing
 *     and raises nothing; `string_contains: 5` compiled to `%5%`. Prisma raises
 *     for both.
 *
 *   - **`equals` / `not` accepted a non-scalar.** On Postgres the comparison
 *     binds `String(raw)` because `#>>` yields text, so `equals: { b: 1 }` bound
 *     the string `"[object Object]"` and matched nothing.
 *
 *   - **`null` fell between the two.** The string branch refuses a non-string
 *     and the object branch tests `operand !== null` first, so `equals: null`
 *     reached the binder and compiled to `= NULL` — see the guard below.
 *
 * The last two are a **refusal rather than an implementation**, deliberately.
 * Prisma does accept an object or an array there, and answering it properly
 * means the `#>` + `::jsonb` form `array_contains` already uses — which is
 * Postgres-only, so implementing it would give SQLite either a second wrong
 * answer or a silent divergence. Refusing names the limitation on both
 * dialects, which is what this file does everywhere else it cannot answer.
 * `array_contains` is exempt from the object rule because containment is
 * precisely the operator that takes a document — but not from the `null` one,
 * because a bound SQL NULL is not a JSON `null` on either side of `@>`.
 */
function assertJsonOperand(
  key: string,
  operand: unknown,
  schema: ModelSchema,
  field: FieldSchema,
  context: WhereContext,
): void {
  const stringly =
    key === "string_contains" ||
    key === "string_starts_with" ||
    key === "string_ends_with";

  if (stringly && typeof operand !== "string") {
    throw new InvalidArgumentError(
      `where.${field.name}.${key}`,
      schema.name,
      context.operation,
      `Expected a string, received ${
        operand === null ? "null" : typeof operand
      }. Prisma raises here too — without this the pattern becomes ` +
        `'%${String(operand)}%', which runs and returns the wrong rows.`,
    );
  }

  // **`null` is refused under every path operator, and it is a refusal rather
  // than a gap.**
  //
  // Measured on a generated 6.19.2 client against Postgres, with query-event
  // logging and the rows read back: Prisma extracts with `#>` and compares as
  // `jsonb`, so `{ path: ["a"], equals: null }` asks for the JSON value `null`
  // and returns the rows that hold one — the same SQL and the same rows as
  // `equals: Prisma.JsonNull`. gemi extracts with `#>>`, which yields *text*,
  // and NULL for an absent key and for a JSON null alike. That collapse is
  // exactly why the sentinels are refused a few lines above, and it leaves this
  // operand nothing to mean.
  //
  // Left alone it reached the binder and compiled to `("metadata" #>> $1) = $2`
  // bound to NULL — `= NULL` is NULL rather than true on both dialects, so the
  // query ran, raised nothing, and matched no row where Prisma matched some.
  // The `string_contains` guard above names that failure in this file's own
  // words, "runs and returns the wrong rows"; only the arithmetic differs.
  //
  // `array_contains` is included rather than exempt, **and its mechanism is a
  // different one**. It takes the `#>` form, so the text collapse above does
  // not apply to it — but `jsonArrayContains` binds the operand raw, so `null`
  // arrives as SQL NULL and `x @> NULL` is NULL too. Prisma binds it as the
  // JSON value and runs a real containment test. The message below branches for
  // that reason: telling an `array_contains` caller about `#>>` would name a
  // mechanism this operator does not have, and pointing them at
  // `{ equals: Prisma.JsonNull }` would answer a containment question with an
  // equality on the column.
  //
  // Answering any of them properly means the `#> … ::jsonb` form on Postgres
  // and `json_type` on SQLite, which is a second implementation of the same
  // operator per dialect rather than a guard — the same reason the object
  // operand below is refused instead of compiled.
  if (operand === null) {
    throw new InvalidArgumentError(
      `where.${field.name}.${key}`,
      schema.name,
      context.operation,
      key === "array_contains"
        ? `null cannot be tested for containment through a JSON path: the ` +
          `operand binds as SQL NULL rather than as the JSON value, and ` +
          `'x @> NULL' is NULL rather than true — the query would run and ` +
          `match nothing. Prisma binds it as the JSON value and runs a real ` +
          `containment test; gemi does not yet. A null *inside* the document ` +
          `is an ordinary value and still compiles: ` +
          `{ ${field.name}: { path: […], array_contains: [null] } }.`
        : `null cannot be compared through a JSON path: the extraction yields ` +
          `SQL NULL for an absent key and for a JSON null alike, and the ` +
          `comparison against it is NULL rather than true — the query would ` +
          `run and match nothing. Prisma reads it as the JSON value null and ` +
          `does answer it; gemi does not yet. Filter the column itself — ` +
          `{ ${field.name}: { equals: Prisma.JsonNull } } — or test the path ` +
          `against the value you mean.`,
    );
  }

  if (key === "array_contains" || stringly) return;

  // `equals`, `not`, and the four numeric comparisons all compare an extracted
  // scalar against one bound value. No `!== null` here: `typeof null` is
  // `"object"`, and the guard above has already refused it with its own reason.
  if (typeof operand === "object") {
    throw new UnsupportedQueryError(
      `where.${field.name}.${key}`,
      schema.name,
      context.operation,
      `'${key}' on a JSON path compares the extracted value as a scalar, so ` +
        `an object or array operand cannot be expressed — it would bind as ` +
        `'${String(operand)}' and match nothing. Prisma accepts one here; ` +
        `gemi does not yet. Use array_contains for containment, or narrow the ` +
        `path until it names a scalar.`,
    );
  }
}

/** The comparison for one JSON filter key. */
function jsonComparison(
  key: string,
  column: string,
  path: Binder,
  field: FieldSchema,
  dialect: SqlDialect,
  value: Binder,
): Fragment {
  if (key === "array_contains") {
    return dialect.jsonArrayContains(column, path, value);
  }

  // The string filters compare *text*, so they need the text-returning
  // extraction; everything else compares the value.
  const stringly =
    key === "string_contains" ||
    key === "string_starts_with" ||
    key === "string_ends_with";

  const extracted = dialect.jsonExtract(column, path, true);

  if (stringly) {
    const wrap =
      key === "string_contains"
        ? (text: string) => `%${text}%`
        : key === "string_starts_with"
          ? (text: string) => `${text}%`
          : (text: string) => `%${text}`;

    return concat(
      sql("("),
      extracted,
      sql(") like "),
      param((args, context) => {
        const raw = value(args, context);
        return raw === null || raw === undefined ? null : wrap(String(raw));
      }),
    );
  }

  const operator =
    key === "equals" ? "=" : key === "not" ? "<>" : COMPARISONS[key];

  // `#>>` and `json_extract` both yield text, so a numeric comparison has to
  // compare numbers rather than their spellings — otherwise "10" < "9". The
  // cast is structural, never a value.
  const numeric = key !== "equals" && key !== "not";
  const lhs = numeric
    ? concat(sql("cast(("), extracted, sql(") as real)"))
    : concat(sql("("), extracted, sql(")"));

  return concat(
    lhs,
    sql(` ${operator} `),
    param((args, context) => {
      const raw = value(args, context);
      if (raw === null || raw === undefined) return null;
      if (numeric) return Number(raw);
      // Text on Postgres, native on SQLite — see `jsonComparesAsText`. The
      // wrong one returns no rows on one dialect and raises on the other.
      return dialect.jsonComparesAsText ? String(raw) : raw;
    }),
  );
}

/** The path is a string on SQLite and an array of string keys on Postgres. */
function assertPathShape(
  schema: ModelSchema,
  field: FieldSchema,
  path: unknown,
  context: WhereContext,
): void {
  const { dialect } = context;
  const wanted = dialect.jsonPathSyntax === "array" ? "array" : "jsonpath";
  const got = Array.isArray(path) ? "array" : typeof path === "string" ? "jsonpath" : "other";

  // **The empty path is refused on both dialects, and it is not the same
  // mistake as a wrong shape.** `[]` on Postgres extracts the whole document —
  // `[].every` is vacuously true, so it used to pass this check — and `""` on
  // SQLite raises inside `json_extract` at execution time. Neither is a path,
  // and a caller who wrote one meant to write something. Refused with its own
  // sentence rather than the grammar message below, which would tell them to
  // use the form they already used.
  const empty =
    (Array.isArray(path) && path.length === 0) || path === "";
  if (empty) {
    throw new UnsupportedQueryError(
      `${field.name}.path`,
      schema.name,
      context.operation,
      `A JSON path cannot be empty. ${
        dialect.jsonPathSyntax === "array"
          ? `On ${dialect.name} an empty array selects the whole document, ` +
            `which is a filter on the column rather than on a path — write ` +
            `{ ${field.name}: { equals: … } } if that is what you meant.`
          : `On ${dialect.name} an empty string raises inside json_extract.`
      }`,
    );
  }

  if (got === wanted) {
    if (wanted !== "array") return;

    // **Every segment is a string, and the number that used to be allowed here
    // was a superset of the oracle.** Prisma's generated `path` on Postgres is
    // `string[]`, and its client refuses a number at run time as well as at
    // compile time — measured on 6.19.2: `path: ["items", 0]` answers
    // *"Argument `path`: Invalid value provided. Expected String, provided
    // Int."* before any SQL is built.
    //
    // Refused rather than kept, because this file already states the rule that
    // decides it: answering a query the oracle cannot express is "precisely
    // where a differential test stops being able to check anything"
    // (`compileJsonFilter`'s docblock, on the SQLite operators). Nothing is
    // lost — `["items", "0"]` reaches the same array element, since `#>` takes
    // a `text[]` and the segment arrives as text either way. Measured: both
    // spellings bind `["items", "0"]` and return the same row on Prisma, and
    // gemi's binder already stringifies through the `text[]` cast.
    //
    // Its own sentence rather than the grammar message below, which would tell
    // a caller who wrote an array to write an array.
    const offending = (path as unknown[]).findIndex(
      (part) => typeof part !== "string",
    );
    if (offending === -1) return;

    // `a ${typeof part}` alone reads as "a undefined" / "a object" for every
    // segment but the number, so the description is spelled out. And the array
    // index sentence is advice for one mistake in particular — a caller who
    // wrote `null` did not write an index — so it is gated on the number
    // rather than emitted for everything.
    const part = (path as unknown[])[offending];
    const described =
      part === null
        ? "null"
        : part === undefined
          ? "undefined"
          : Array.isArray(part)
            ? "an array"
            : typeof part === "object"
              ? "an object"
              : `a ${typeof part}`;

    throw new UnsupportedQueryError(
      `${field.name}.path`,
      schema.name,
      context.operation,
      `A JSON path is an array of strings, and path[${offending}] is ` +
        `${described}. ` +
        (typeof part === "number"
          ? `An array index is a key too — write ["items", "0"] rather than ` +
            `["items", 0]; it reaches the same element, because ` +
            `${dialect.name} takes the path as text. Prisma's path is ` +
            `string[] and its client refuses a number here too.`
          : `Prisma's path is string[] too.`),
    );
  }

  throw new UnsupportedQueryError(
    `${field.name}.path`,
    schema.name,
    context.operation,
    dialect.jsonPathSyntax === "array"
      ? `On ${dialect.name} a JSON path is an array of keys — ["a", "b"] — ` +
        `not a JSONPath string. Prisma splits them the same way, and refuses ` +
        `the other form on each database.`
      : `On ${dialect.name} a JSON path is a JSONPath string — "$.a.b" — not ` +
        `an array of keys. Prisma splits them the same way, and refuses the ` +
        `other form on each database.`,
  );
}

function compileFieldFilter(
  schema: ModelSchema,
  field: FieldSchema,
  value: unknown,
  context: WhereContext,
  locate: (args: any) => any,
): Fragment {
  const { dialect } = context;
  const column = `${context.qualifier ?? ""}${dialect.quoteIdent(field.column)}`;

  // A bare `Prisma.DbNull` is **not** shorthand for `equals`, and Prisma refuses
  // it: `where: { settings: Prisma.DbNull }` is an invalid invocation there,
  // spelled out under the offending key. Both sentinels are objects with no
  // enumerable properties, so left alone they read as an operator map holding
  // no operators — which compiles to `true`, and answered "every row" to a
  // question about the null ones.
  //
  // Refused rather than interpreted, because guessing which of the two nulls a
  // caller meant is the whole thing the sentinels exist to stop, and because
  // matching Prisma means matching its refusals as well as its results.
  const sentinel = jsonNullKind(value);
  if (sentinel) {
    throw new InvalidArgumentError(
      `where.${field.name}`,
      schema.name,
      context.operation,
      `${sentinelName(sentinel)} is not a filter on ` +
        `its own — Prisma rejects it here too. Write it as an explicit ` +
        `comparison: { ${field.name}: { equals: ${sentinelName(sentinel)} } }.`,
    );
  }

  // A scalar list takes a different operator set on a different left-hand side,
  // so the whole operand belongs to that branch — the same shape the `path`
  // check below has for a JSON document. Placed *above* the bare-value
  // shorthand because on a list the bare form is an **array**, which
  // `isFilterObject` reports as a value and would send to the scalar `equals`
  // with no dialect check and no operand validation.
  if (field.isList) {
    return compileListFilter(schema, field, column, value, context, locate);
  }

  // A bare value is shorthand for `equals`. A `Date` is a value, not a filter
  // object, even though `typeof` cannot tell them apart.
  if (!isFilterObject(value)) {
    return equals(column, field, value, dialect, locate);
  }

  const filter = value as Record<string, unknown>;
  const keys = Object.keys(filter).sort();

  // A `path` turns the whole operand into a JSON filter, whose operators are a
  // different set from the scalar ones and whose left-hand side is an
  // extraction rather than a column.
  if (filter.path !== undefined) {
    return compileJsonFilter(schema, field, column, filter, context, locate);
  }

  // Prisma-only, and only meaningful next to a string operator. Read here so it
  // does not get treated as an operator in its own right.
  const insensitive = filter.mode === "insensitive";
  if (filter.mode !== undefined && filter.mode !== "default") {
    if (!insensitive) {
      throw new InvalidArgumentError(
        `mode: ${JSON.stringify(filter.mode)}`,
        schema.name,
        context.operation,
        `Prisma takes 'default' or 'insensitive'.`,
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
      throw new InvalidArgumentError(
        `where.${field.name}.${key}`,
        schema.name,
        context.operation,
        `A scalar filter takes ${[...OPERATORS].sort().join(", ")}.`,
      );
    }

    // `AnyNull` asks for both nulls at once, which only `equals` and `not` can
    // express. Under any other operator it has no meaning — Prisma's own
    // `JsonNullableFilter` admits it in exactly those two positions — and left
    // alone it would reach the binder, where it is an ORM bug by construction.
    // Refused here, where the field and operation are in scope to name it,
    // rather than at the backstop that would report it as ours.
    if (key !== "equals" && key !== "not" && carriesAnyNull(operand)) {
      throw new InvalidArgumentError(
        `where.${field.name}.${key}`,
        schema.name,
        context.operation,
        `Prisma.AnyNull means 'either kind of null', which only 'equals' and ` +
          `'not' can express. Write { ${field.name}: { equals: Prisma.AnyNull } }, ` +
          `or name the one you mean with Prisma.DbNull or Prisma.JsonNull.`,
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
            fieldParam(field, dialect, encoded(field, dialect, at)),
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
          throw new InvalidArgumentError(
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

/** How a sentinel is spelled in a message, so an error can be pasted back as code. */
function sentinelName(kind: JsonNullKind): string {
  return `Prisma.${kind === "db" ? "DbNull" : kind === "json" ? "JsonNull" : "AnyNull"}`;
}

/**
 * Whether an operand is `AnyNull`, or a list holding one.
 *
 * The list case is the reachable one: `in: [Prisma.AnyNull]` type-checks
 * nowhere in Prisma, but nothing stops it being written in JavaScript, and
 * `inList` would bind it as an ordinary value.
 */
function carriesAnyNull(operand: unknown): boolean {
  if (jsonNullKind(operand) === "any") return true;
  return Array.isArray(operand) && operand.some((item) => jsonNullKind(item) === "any");
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
  // `DbNull` is the sentinel spelling of the same question, so it takes the
  // same branch — see `equals`.
  if (operand === null || jsonNullKind(operand) === "db") {
    return sql(`${column} is not null`);
  }

  // `JsonNull` does not: it asks about a stored JSON *value*, so negating it is
  // a value comparison. Handled here rather than by delegating, because the
  // delegate refuses a bare sentinel — correctly, since Prisma does — and this
  // one did not arrive bare. `{ not: Prisma.JsonNull }` is a valid Prisma
  // filter and has to stay one.
  if (jsonNullKind(operand) === "json") {
    return concat(
      sql("not "),
      parenthesize(equals(column, field, operand, context.dialect, locate)),
    );
  }

  // `not: AnyNull` is "neither kind of null", so it negates the union `equals`
  // builds. Safe to negate directly because that predicate is total — see the
  // note there — so no row falls through on NULL the way `not (col = value)`
  // would.
  if (jsonNullKind(operand) === "any") {
    return concat(
      sql("not "),
      parenthesize(equals(column, field, operand, context.dialect, locate)),
    );
  }

  if (!isFilterObject(operand)) {
    return concat(
      sql(`${column} <> `),
      fieldParam(field, context.dialect, encoded(field, context.dialect, locate)),
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
  //
  // `Prisma.DbNull` means the same thing on a `Json` column and arrives as a
  // sentinel object rather than as `null`, so it reached the parameter path
  // below and compiled to `= ?` — matching nothing, whatever the table held.
  // Its sibling `JsonNull` is a genuine *value* comparison and belongs there:
  // the column holds the JSON `null`, and `= 'null'` is how you find it.
  if (operand === null || jsonNullKind(operand) === "db") {
    return sql(`${column} is null`);
  }

  // `AnyNull` is the union of the other two, and the only operand here that is
  // not a single comparison. Both halves are needed: the column being SQL NULL
  // and the column holding the JSON value `null` are different rows, and this
  // is the one filter that asks for both.
  //
  // No three-valued-logic trap in the `or`. `is null` is never NULL, and when
  // the column is non-NULL the second half is a proper boolean — so the
  // predicate is total, which is what makes negating it in `compileNot` safe.
  if (jsonNullKind(operand) === "any") {
    return group(
      [sql(`${column} is null`), jsonNullComparison(column, field, dialect)],
      " or ",
    );
  }

  return concat(
    sql(`${column} = `),
    fieldParam(field, dialect, encoded(field, dialect, locate)),
  );
}

/**
 * `<column> = <the JSON value null>`, as a bound parameter.
 *
 * The literal is the compiler's, not the caller's, so there is no argument to
 * read it out of — but it stays a parameter rather than being written into the
 * text, because invariant 2 admits no exception for a value the compiler
 * happens to know. It is also what keeps the dialects' encoders as the single
 * authority on how a JSON null is spelled: `'null'` on SQLite, `'null'::text::jsonb`
 * on Postgres, decided by `fieldParam` and `castParameter` rather than here.
 */
function jsonNullComparison(
  column: string,
  field: FieldSchema,
  dialect: SqlDialect,
): Fragment {
  return concat(
    sql(`${column} = `),
    fieldParam(field, dialect, () => dialect.encode(JSON_NULL, field)),
  );
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
    throw new InvalidArgumentError(
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
