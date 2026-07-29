import type { SqlDialect } from "../dialect";
import {
  InvalidArgumentError,
  UnknownFieldError,
  UnsupportedQueryError,
} from "../errors";
import type { QueryPlan } from "../plan";
import type { FieldSchema, ModelSchema, ScalarType } from "../schema";
import {
  type Fragment,
  bindValues,
  concat,
  joinFragments,
  render,
  sql,
} from "./fragment";
import { compileOrderBy, parseOrderBy } from "./orderBy";
import { pagination } from "./paginate";
import { compileWhere } from "./where";

/**
 * `aggregate`, and the `select` form of `count`.
 *
 * The fourteenth operation, and the first read whose result is neither rows nor
 * a bare number. Its shape is Prisma's, verified against a generated client
 * rather than inferred from the docs — every claim in this file's comments is a
 * line of that probe's output.
 *
 * ## Why it is not just `count` with more functions
 *
 * Three things differ, and each one is a place a plausible implementation is
 * wrong:
 *
 * 1. **`_count` has two shapes.** `_count: true` returns a *number*;
 *    `_count: { _all: true, email: true }` returns an object, and a per-field
 *    count is `count("email")` — the number of rows where that column is **not
 *    null**, which is a different number from `count(*)` and is the whole point
 *    of asking per field.
 * 2. **The empty set is not zeroes.** `_count` over no rows is `0`, but `_sum`,
 *    `_avg`, `_min` and `_max` are all `null` — per field, inside their objects.
 *    An implementation that coalesced to `0` would be wrong in the direction
 *    nobody checks.
 * 3. **The driver's types are not the column's types.** `sum(integer)` is
 *    `bigint` in Postgres and `avg(integer)` is `numeric`, and Bun hands both
 *    back as *strings*. So the coercion cannot be `dialect.decode(value, field)`
 *    — that decodes a value of the column's type, and an aggregate is not one.
 *    See `coerce` below, where each rule is a measurement.
 *
 * ## Pagination
 *
 * `take` / `skip` describe the rows being aggregated, not the one row the
 * aggregate produces — exactly as they do for `count`, and for the same reason:
 * `limit` beside an aggregate caps the result, which is always one row. So a
 * paginated aggregate wraps its row query in a subquery, the same shape
 * `compileRead` uses. Verified against Prisma: `take: 2` with
 * `orderBy: { globalRole: "asc" }` over rows 0, 5, 10 sums to 5, not 15.
 */

/** The aggregate functions Prisma exposes, in the order it returns them. */
export const KINDS = ["_count", "_avg", "_sum", "_min", "_max"] as const;
export type Kind = (typeof KINDS)[number];

const AGGREGATE_ARGS = new Set<string>([
  "where",
  "orderBy",
  "take",
  "skip",
  ...KINDS,
]);

/**
 * `_sum` and `_avg` need arithmetic, so Prisma restricts them to these.
 *
 * `Decimal` is listed for completeness and cannot occur: `emit.ts` refuses a
 * Decimal field at generation time, so no generated schema has one.
 */
const NUMERIC = new Set<ScalarType>(["Int", "Float", "BigInt", "Decimal"]);

/**
 * `_min` / `_max` need an ordering. `Json` has none in either dialect, and
 * `Bytes` orders bytewise in a way Prisma does not expose — both are refused
 * rather than emitted and left to disagree.
 */
const UNORDERABLE = new Set<ScalarType>(["Json", "Bytes"]);

/** The SQL function each kind compiles to. */
export const FUNCTION: Record<Kind, string> = {
  _count: "count",
  _avg: "avg",
  _sum: "sum",
  _min: "min",
  _max: "max",
};

export interface Term {
  kind: Kind;
  /** Absent for `_count`'s `_all`, which is `count(*)`. */
  field?: FieldSchema;
  /** The key this term is written to inside its kind's object. */
  as: string;
  /** The column alias it comes back under. Positional, so it cannot collide. */
  alias: string;
}

export function isAggregateOperation(op: string): boolean {
  return op === "aggregate";
}

/**
 * `aggregate`, and `count({ select })` — which is the same statement with a
 * flatter result.
 *
 * Prisma's `count({ select: { _all: true, email: true } })` returns
 * `{ _all: 3, email: 2 }`: no `_count` wrapper, because the operation already
 * says what the numbers are. It was refused here until now as "aggregate
 * territory", which was the right call while there was no aggregate to put it
 * beside; the two decisions belong together and this is the together.
 *
 * **No `ExecOptions`**, unlike every neighbouring read, and that is deliberate
 * rather than an omission: `strategy` chooses how an include tree loads and an
 * aggregate has no relations, `track` records where a row came from so `save`
 * can update it and an aggregate returns no rows. Accepting either and ignoring
 * it would be worse than not accepting it.
 */
export function compileAggregate(
  schema: ModelSchema,
  op: string,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  const flat = op === "count";
  assertArgs(schema, op, args, flat);

  const terms = flat
    ? countSelectTerms(schema, op, args?.select)
    : aggregateTerms(schema, op, args);

  if (terms.length === 0) {
    throw new UnsupportedQueryError(
      op,
      schema.name,
      op,
      flat
        ? `A 'select' on a count must name at least one field, or '_all'.`
        : `An aggregate needs at least one of ${KINDS.join(", ")}. Prisma ` +
            `rejects an empty one too.`,
    );
  }

  const where = compileWhere(
    schema,
    args?.where,
    { dialect, operation: op },
    (a) => a?.where,
  );
  const whereClause = where ? concat(sql(" where "), where) : sql("");
  const from = sql(` from ${dialect.quoteIdent(schema.table)}`);

  const projection = joinFragments(
    terms.map((term) =>
      sql(
        `${FUNCTION[term.kind]}(${
          term.field ? dialect.quoteIdent(term.field.column) : "*"
        }) as ${dialect.quoteIdent(term.alias)}`,
      ),
    ),
    ", ",
  );

  // Parsed unconditionally, so that validation does not depend on whether a
  // *different* argument was also supplied — the same rule `count` follows.
  const parsed = parseOrderBy(schema, args?.orderBy, op, {
    dialect,
    locate: (a: any) => a?.orderBy,
  });
  const paginating = args?.take !== undefined || args?.skip !== undefined;

  let statement: Fragment;

  if (!paginating) {
    statement = concat(sql("select "), projection, from, whereClause);
  } else {
    const { clause, terms: order } = pagination(
      schema,
      op,
      args,
      dialect,
      parsed,
    );
    const ordering = compileOrderBy(order, dialect);

    // The subquery selects every column an aggregate names — an `order by` may
    // reference columns beyond them, which is fine, since it is resolved
    // against the table rather than against the select list.
    //
    // With only `count(*)` there is no such column, so it selects the primary
    // key: the narrowest thing that keeps a row identity, which is what
    // `compileRead`'s paginated count does for the same reason.
    const columns = new Map<string, string>();
    for (const term of terms) {
      if (term.field) columns.set(term.field.column, term.field.column);
    }
    if (columns.size === 0) {
      const key = schema.primaryKey[0] ?? Object.keys(schema.fields)[0];
      const column = schema.fields[key]?.column ?? key;
      columns.set(column, column);
    }

    statement = concat(
      sql("select "),
      projection,
      sql(
        ` from (select ${[...columns.values()]
          .map((column) => dialect.quoteIdent(column))
          .join(", ")}`,
      ),
      from,
      whereClause,
      ordering ? concat(sql(" order by "), ordering) : sql(""),
      clause,
      sql(`) as ${dialect.quoteIdent("sub")}`),
    );
  }

  const { text, binders } = render(statement, dialect, {
    model: schema.name,
    operation: op,
  });

  return {
    text,
    bind: bindValues(binders),
    shape(rows) {
      const row = (rows as Record<string, unknown>[])[0] ?? {};

      if (flat) {
        const out: Record<string, unknown> = {};
        for (const term of terms)
          out[term.as] = coerce(term, row[term.alias], dialect);
        return out;
      }

      const out: Record<string, unknown> = {};
      for (const term of terms) {
        // `_count: true` is a number rather than an object, and it is the only
        // aggregate that can be either.
        if (term.kind === "_count" && term.as === BARE) {
          out._count = coerce(term, row[term.alias], dialect);
          continue;
        }
        const bucket = (out[term.kind] ??= {}) as Record<string, unknown>;
        bucket[term.as] = coerce(term, row[term.alias], dialect);
      }
      return out;
    },
  };
}

/** The `as` a bare `_count: true` carries, which no field name can be. */
export const BARE = "";

export function aggregateTerms(
  schema: ModelSchema,
  op: string,
  args: any,
): Term[] {
  const terms: Term[] = [];

  for (const kind of KINDS) {
    const requested = args?.[kind];
    if (requested === undefined || requested === false) continue;

    if (kind === "_count" && requested === true) {
      terms.push({ kind, as: BARE, alias: alias(kind, terms.length) });
      continue;
    }

    if (
      typeof requested !== "object" ||
      requested === null ||
      Array.isArray(requested)
    ) {
      throw new InvalidArgumentError(
        kind,
        schema.name,
        op,
        kind === "_count"
          ? `Expected true or an object of fields.`
          : `Expected an object of fields.`,
      );
    }

    for (const key of Object.keys(requested).sort()) {
      const wanted = (requested as Record<string, unknown>)[key];
      if (wanted === undefined || wanted === false) continue;

      if (kind === "_count" && key === "_all") {
        terms.push({ kind, as: "_all", alias: alias(kind, terms.length) });
        continue;
      }

      const field = resolveField(schema, op, kind, key);
      assertAggregable(schema, op, kind, field);
      terms.push({ kind, field, as: key, alias: alias(kind, terms.length) });
    }
  }

  return terms;
}

/** `count({ select: { _all: true, email: true } })` — every term a `count`. */
function countSelectTerms(
  schema: ModelSchema,
  op: string,
  select: any,
): Term[] {
  if (typeof select !== "object" || select === null || Array.isArray(select)) {
    throw new InvalidArgumentError(
      "select",
      schema.name,
      op,
      `Expected an object of fields.`,
    );
  }

  const terms: Term[] = [];
  for (const key of Object.keys(select).sort()) {
    const wanted = select[key];
    if (wanted === undefined || wanted === false) continue;

    if (key === "_all") {
      terms.push({
        kind: "_count",
        as: "_all",
        alias: alias("_count", terms.length),
      });
      continue;
    }

    const field = resolveField(schema, op, "_count", key);
    terms.push({
      kind: "_count",
      field,
      as: key,
      alias: alias("_count", terms.length),
    });
  }
  return terms;
}

/**
 * Positional, so two terms can never collide however the model is named — a
 * field called `_all` would otherwise produce the same alias as `_count`'s own.
 * The kind stays in the name because a query log is read by a person.
 */
const alias = (kind: Kind, index: number) => `${kind}_${index}`;

export function resolveField(
  schema: ModelSchema,
  op: string,
  kind: Kind,
  name: string,
): FieldSchema {
  const field = schema.fields[name];
  if (!field) {
    // A relation named here is a plausible mistake with an unhelpful default
    // message, so it gets its own.
    if (name in schema.relations) {
      throw new UnsupportedQueryError(
        `${kind}.${name}`,
        schema.name,
        op,
        `'${name}' is a relation. Aggregate its own model instead, or use ` +
          `'_count' inside an 'include' to count it per row.`,
      );
    }
    throw new UnknownFieldError(name, schema.name, Object.keys(schema.fields));
  }
  return field;
}

export function assertAggregable(
  schema: ModelSchema,
  op: string,
  kind: Kind,
  field: FieldSchema,
): void {
  if ((kind === "_sum" || kind === "_avg") && !NUMERIC.has(field.type)) {
    throw new UnsupportedQueryError(
      `${kind}.${field.name}`,
      schema.name,
      op,
      `'${field.name}' is a ${field.type}, and ${kind} needs a number. ` +
        `Prisma does not offer it on this field either.`,
    );
  }

  if ((kind === "_min" || kind === "_max") && UNORDERABLE.has(field.type)) {
    throw new UnsupportedQueryError(
      `${kind}.${field.name}`,
      schema.name,
      op,
      `'${field.name}' is a ${field.type}, which has no ordering the two ` +
        `dialects agree on.`,
    );
  }
}

/**
 * The driver's value for one aggregate, as the value Prisma returns.
 *
 * **Every line here is a measurement**, taken through Bun against Postgres 16
 * and SQLite, because the obvious rule — "decode it as the column's type" — is
 * wrong for three of the five kinds. What Postgres returns:
 *
 *   count(*)             "2"                    string
 *   count(text)          "2"                    string
 *   sum(integer)         "4"                    string   <- bigint
 *   sum(bigint)          "9007199254740995"     string
 *   sum(double)          4                      number
 *   avg(integer)         "2.0000000000000000"   string   <- numeric
 *   avg(double)          2                      number
 *   min(integer)         1                      number
 *   max(text)            "b"                    string
 *   min(timestamp)       Date                   object
 *   max(bigint)          "9007199254740993"     string
 *
 * ...and over an empty set every one of them is `null` except the counts, which
 * are `"0"`.
 *
 * So:
 *
 * - **`_count` is always a number**, and always present. `Number("0")` rather
 *   than a coalesce, because the driver gives a string and `?? 0` would leave it
 *   one.
 * - **`_avg` is always a number**, whatever the column is — Prisma returns a
 *   float for the average of an `Int`, and Postgres hands back `numeric` text.
 * - **`_sum` keeps the column's type**, so it is the one kind where a `BigInt`
 *   column matters: `sum(bigint)` crosses as an exact string, and `Number()` on
 *   9007199254740995 would silently drop the low bits. Same trap the lateral
 *   strategy's `::text` cast exists for.
 * - **`_min` / `_max` are values of the column**, so here — and only here — the
 *   dialect's own `decode` is exactly right. It is what turns SQLite's integer
 *   milliseconds back into a `Date`.
 */
export function coerce(
  term: Term,
  value: unknown,
  dialect: SqlDialect,
): unknown {
  if (term.kind === "_count") return Number(value ?? 0);

  // Every other aggregate is null over an empty set, and per field.
  if (value === null || value === undefined) return null;

  if (term.kind === "_avg") return Number(value);

  if (term.kind === "_sum") {
    const type = term.field?.type;
    if (type === "BigInt") return BigInt(String(value));
    // `Decimal` is **unreachable**, not merely untested: `emit.ts`'s
    // `UNSUPPORTED_SCALARS` refuses a Decimal field at generation time, so no
    // generated schema can carry one and neither this branch nor `Decimal`'s
    // membership of `NUMERIC` can be entered.
    //
    // Kept, and kept as a pass-through, because the day Decimal becomes
    // supported is the day this needs a real decision — Postgres returns
    // `sum(numeric)` as text, and whether that becomes a `Prisma.Decimal`, a
    // string or a number is the same question the generator declined to answer.
    // Silently `Number()`-ing it would answer it wrongly and lose exactly the
    // precision the type exists to keep.
    if (type === "Decimal") return value;
    return Number(value);
  }

  // `_min` / `_max` are values *of the column*, so here — and only here — the
  // dialect's own `decode` is exactly right. It is what turns SQLite's integer
  // milliseconds back into a `Date`, and Postgres's `bigint` text into a
  // `BigInt`. Without it a `_max: { createdAt: true }` comes back as
  // 1600000004000 where Prisma returns a `Date`, on SQLite only — which is the
  // shape of every bug this file's coercion table exists to prevent.
  return term.field ? dialect.decode(value, term.field) : value;
}

function assertArgs(
  schema: ModelSchema,
  op: string,
  args: any,
  flat: boolean,
): void {
  if (args === undefined || args === null) {
    if (flat) return;
    throw new UnsupportedQueryError(
      op,
      schema.name,
      op,
      `An aggregate needs at least one of ${KINDS.join(", ")}.`,
    );
  }

  if (typeof args !== "object" || Array.isArray(args)) {
    throw new InvalidArgumentError(
      String(args),
      schema.name,
      op,
      "Expected an object.",
    );
  }

  if (flat) return;

  for (const key of Object.keys(args).sort()) {
    if (args[key] === undefined) continue;
    if (AGGREGATE_ARGS.has(key)) continue;

    // `select` and `include` are the two a caller reaches for by habit, and
    // neither means anything here: an aggregate's shape is decided entirely by
    // which functions were asked for.
    if (key === "select" || key === "include") {
      throw new UnsupportedQueryError(
        key,
        schema.name,
        op,
        `An aggregate returns the functions it was given, so there is nothing ` +
          `to ${key === "select" ? "select" : "include"}. Prisma does not ` +
          `accept it either.`,
      );
    }

    throw new UnsupportedQueryError(
      key,
      schema.name,
      op,
      `${op} takes ${[...AGGREGATE_ARGS].sort().join(", ")}.`,
    );
  }
}
