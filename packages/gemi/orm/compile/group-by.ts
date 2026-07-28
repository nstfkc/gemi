import type { SqlDialect } from "../dialect";
import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import type { QueryPlan } from "../plan";
import type { FieldSchema, ModelSchema } from "../schema";
import {
  BARE,
  FUNCTION,
  KINDS,
  type Kind,
  type Term,
  aggregateTerms,
  assertAggregable,
  coerce,
  resolveField,
} from "./aggregate";
import {
  type Fragment,
  bindValues,
  concat,
  joinFragments,
  param,
  render,
  sql,
} from "./fragment";
import { pagination } from "./paginate";
import { compileWhere } from "./where";

/**
 * `groupBy` — the second half of #64, and the half that is not just `aggregate`
 * with a `group by` bolted on.
 *
 * Three things make it its own compiler rather than a flag on `compileAggregate`:
 *
 * - The result is **many rows with a mixed shape**: the grouped columns arrive
 *   flat, the aggregates arrive nested under their kind, in one object.
 * - `having` is a second predicate compiler. It filters *groups*, so its
 *   operands are aggregate expressions as well as columns, and it has to emit
 *   `count("x") > $1` where `compileWhere` would emit `"x" > $1`.
 * - `orderBy` is restricted in a way no other operation's is, and it can name an
 *   aggregate.
 *
 * Every rule below was read off a live Prisma 6 client rather than from its
 * documentation, because several of them are not what the shape suggests — most
 * of all that `orderBy` is *optional* here, where the issue that asked for this
 * predicted it would be mandatory.
 */

const GROUP_BY_ARGS = new Set<string>([
  "by",
  "where",
  "orderBy",
  "having",
  "take",
  "skip",
  ...KINDS,
]);

export function isGroupByOperation(op: string): boolean {
  return op === "groupBy";
}

/** One grouped column, and the key it comes back under. */
interface Grouped {
  field: FieldSchema;
  alias: string;
}

/**
 * **No `ExecOptions`**, for the reason `aggregate` has none: `strategy` chooses
 * how an include tree loads and there are no relations here, `track` records
 * where a row came from so `save` can update it and a group is not a row.
 */
export function compileGroupBy(
  schema: ModelSchema,
  op: string,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  assertArgs(schema, op, args);

  const grouped = groupedColumns(schema, op, args?.by);
  const terms = aggregateTerms(schema, op, args);

  const from = sql(` from ${dialect.quoteIdent(schema.table)}`);
  const where = compileWhere(schema, args?.where, { dialect, operation: op }, (a) => a?.where);
  const whereClause = where ? concat(sql(" where "), where) : sql("");

  // The grouped columns first, then the aggregates. Prisma returns them the
  // other way round in key order, which `shape` reproduces; the *select* list
  // order is ours and the readable one is grouping first.
  const projection = joinFragments(
    [
      ...grouped.map((column) =>
        sql(
          `${dialect.quoteIdent(column.field.column)} as ${dialect.quoteIdent(column.alias)}`,
        ),
      ),
      ...terms.map((term) => sql(functionOf(term, dialect))),
    ],
    ", ",
  );

  const groupClause = concat(
    sql(" group by "),
    joinFragments(
      grouped.map((column) => sql(dialect.quoteIdent(column.field.column))),
      ", ",
    ),
  );

  const having = compileHaving(schema, op, args?.having, grouped, dialect);
  const havingClause = having ? concat(sql(" having "), having) : sql("");

  const ordering = compileGroupOrdering(schema, op, args?.orderBy, grouped, dialect);
  const orderClause = ordering ? concat(sql(" order by "), ordering) : sql("");

  // `take` / `skip` page the **groups**, which is what `limit` after `group by`
  // already means — so unlike `aggregate`, which has to wrap its rows in a
  // subquery to keep the limit off the single result row, this needs no
  // subquery at all.
  //
  // `parsed` is empty because the ordering above is already compiled: a group's
  // `order by` may name an aggregate, which `parseOrderBy` has no way to
  // express. Passing an empty list means `pagination` contributes only the
  // `limit` / `offset`, and its "paginating with no orderBy sorts by the primary
  // key" fallback cannot fire — correctly, because the primary key is not
  // grouped and Prisma does not add one either.
  //
  // **This is the fourth pager, and #88 predicted it.** That PR moves `take` /
  // `skip` validation into `pagination` itself rather than into each caller's
  // argument allowlist, on the argument that a fourth one should not be able to
  // arrive without it. On this branch's base it has not merged, so `groupBy`
  // inherits the #84 behaviour — a string `take` binds its magnitude and does
  // not flip anything. It gains the check the moment #88 lands, with no change
  // here, which is the claim being demonstrated rather than restated.
  const paginating = args?.take !== undefined || args?.skip !== undefined;
  const page = paginating ? pagination(schema, args, dialect, []).clause : sql("");

  const statement = concat(
    sql("select "),
    projection,
    from,
    whereClause,
    groupClause,
    havingClause,
    orderClause,
    page,
  );

  const { text, binders } = render(statement, dialect, {
    model: schema.name,
    operation: op,
  });

  return {
    text,
    bind: bindValues(binders),
    shape(rows) {
      return (rows as Record<string, unknown>[]).map((row) => {
        const out: Record<string, unknown> = {};

        // Aggregates first, then the grouped columns: Prisma's own key order,
        // which matters only for a caller reading `Object.keys` but costs
        // nothing to match.
        for (const term of terms) {
          if (term.kind === "_count" && term.as === BARE) {
            out._count = coerce(term, row[term.alias], dialect);
            continue;
          }
          const bucket = (out[term.kind] ??= {}) as Record<string, unknown>;
          bucket[term.as] = coerce(term, row[term.alias], dialect);
        }

        for (const column of grouped) {
          out[column.field.name] = dialect.needsDecode(column.field)
            ? dialect.decode(row[column.alias], column.field)
            : row[column.alias];
        }

        return out;
      });
    },
  };
}

/** `count("x") as "_count_0"`, or `count(*)` for `_count: true` / `_all`. */
function functionOf(term: Term, dialect: SqlDialect): string {
  const operand = term.field ? dialect.quoteIdent(term.field.column) : "*";
  return `${FUNCTION[term.kind]}(${operand}) as ${dialect.quoteIdent(term.alias)}`;
}

/**
 * `by: ["role"]` and `by: "role"` are both Prisma, and the string form is the
 * one a caller reaches for with a single field. Measured, not assumed — it is
 * easy to read the generated types as array-only.
 */
function groupedColumns(schema: ModelSchema, op: string, by: unknown): Grouped[] {
  const names = typeof by === "string" ? [by] : by;

  if (!Array.isArray(names)) {
    throw new UnsupportedQueryError(
      "by",
      schema.name,
      op,
      `Expected a field name or an array of them, got ${JSON.stringify(by)}.`,
    );
  }

  if (names.length === 0) {
    throw new UnsupportedQueryError(
      "by",
      schema.name,
      op,
      `At least one field is required to group by. Prisma rejects an empty ` +
        `'by' too — without one there is nothing to group, and the answer ` +
        `would be 'aggregate'.`,
    );
  }

  const grouped: Grouped[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    if (typeof name !== "string") {
      throw new UnsupportedQueryError(
        "by",
        schema.name,
        op,
        `Expected field names, got ${JSON.stringify(name)}.`,
      );
    }
    // A duplicate is harmless in SQL and would return the column twice under
    // one key, so it is dropped rather than refused.
    if (seen.has(name)) continue;
    seen.add(name);

    if (name in schema.relations) {
      throw new UnsupportedQueryError(
        `by.${name}`,
        schema.name,
        op,
        `'${name}' is a relation. A group is a set of rows of this model, so ` +
          `only its own columns can name one.`,
      );
    }

    const field = schema.fields[name];
    if (!field) {
      throw new UnknownFieldError(name, schema.name, Object.keys(schema.fields));
    }

    grouped.push({ field, alias: `_by_${grouped.length}` });
  }

  return grouped;
}

/**
 * `having`, which filters **groups** rather than rows.
 *
 * Two operand shapes, and Prisma accepts both against the same key:
 *
 *     having: { role: { gt: 0 } }                 the grouped column itself
 *     having: { role: { _count: { gt: 1 } } }     an aggregate over the group
 *
 * The first is only legal because `role` is in `by` — SQL would reject a bare
 * column in `having` otherwise, and Prisma refuses it first with *"Every field
 * used in `having` filters must either be an aggregation filter or be included
 * in the selection of the query"*. That refusal is reproduced rather than left
 * to the database, because the database's version of it names neither the
 * argument nor the model.
 *
 * Written here rather than threaded through `compileWhere` as an option: the
 * operand of an aggregate filter is a *function call*, not a column, and
 * teaching the row-predicate compiler to sometimes wrap its left-hand side
 * would put a group's rules inside the file every ordinary query uses.
 */
function compileHaving(
  schema: ModelSchema,
  op: string,
  having: unknown,
  grouped: Grouped[],
  dialect: SqlDialect,
  path: (args: any) => any = (a) => a?.having,
): Fragment | null {
  if (having === undefined || having === null) return null;
  if (typeof having !== "object" || Array.isArray(having)) {
    throw new UnsupportedQueryError(
      "having",
      schema.name,
      op,
      `Expected an object of field filters.`,
    );
  }

  const source = having as Record<string, unknown>;
  const parts: Fragment[] = [];

  // Sorted, for the reason every walk in this compiler is: the plan cache
  // canonicalises key order, so two argument objects differing only in it have
  // to produce one statement.
  for (const key of Object.keys(source).sort()) {
    const operand = source[key];
    if (operand === undefined) continue;

    if (key === "AND" || key === "OR" || key === "NOT") {
      const combined = combinator(schema, op, key, operand, grouped, dialect, path);
      if (combined) parts.push(combined);
      continue;
    }

    const aggregated = isAggregateFilter(operand);
    const field = havingField(schema, op, key, grouped, aggregated);

    if (aggregated) {
      assertPureAggregate(schema, op, key, operand);
      for (const kind of KINDS) {
        const filter = (operand as Record<string, unknown>)[kind];
        if (filter === undefined) continue;
        assertAggregable(schema, op, kind, field);
        parts.push(
          comparison(
            `${FUNCTION[kind]}(${dialect.quoteIdent(field.column)})`,
            filter,
            schema,
            op,
            `having.${key}.${kind}`,
            (args) => path(args)?.[key]?.[kind],
            dialect,
          ),
        );
      }
      continue;
    }

    parts.push(
      comparison(
        dialect.quoteIdent(field.column),
        operand,
        schema,
        op,
        `having.${key}`,
        (args) => path(args)?.[key],
        dialect,
      ),
    );
  }

  if (parts.length === 0) return null;
  return parts.length === 1
    ? parts[0]
    : concat(sql("("), joinFragments(parts, " and "), sql(")"));
}

function combinator(
  schema: ModelSchema,
  op: string,
  key: "AND" | "OR" | "NOT",
  operand: unknown,
  grouped: Grouped[],
  dialect: SqlDialect,
  path: (args: any) => any,
): Fragment | null {
  const list = Array.isArray(operand) ? operand : [operand];
  const parts: Fragment[] = [];

  for (let index = 0; index < list.length; index++) {
    const at = Array.isArray(operand)
      ? (args: any) => path(args)?.[key]?.[index]
      : (args: any) => path(args)?.[key];
    const compiled = compileHaving(schema, op, list[index], grouped, dialect, at);
    if (compiled) parts.push(compiled);
  }

  if (parts.length === 0) {
    // Matching `compileWhere`: an empty `AND` is vacuously true, an empty `OR`
    // matches nothing. `NOT` of nothing is the same as `AND` of nothing.
    return key === "OR" ? sql("false") : null;
  }

  const joined =
    parts.length === 1
      ? parts[0]
      : concat(sql("("), joinFragments(parts, key === "OR" ? " or " : " and "), sql(")"));

  return key === "NOT" ? concat(sql("not ("), joined, sql(")")) : joined;
}

/** `{ _count: { gt: 1 } }` rather than `{ gt: 1 }`. */
function isAggregateFilter(operand: unknown): boolean {
  if (typeof operand !== "object" || operand === null || Array.isArray(operand)) {
    return false;
  }
  return KINDS.some((kind) => kind in (operand as Record<string, unknown>));
}

/**
 * The field a `having` key names.
 *
 * **The rule is Prisma's own sentence, and it is an `or`:** *"Every field used
 * in `having` filters must either be an aggregation filter or be included in
 * the selection of the query"*. So which form the operand takes decides whether
 * the field has to be grouped:
 *
 *     having: { role:  { gt: 0 } }             role must be in `by`
 *     having: { email: { _count: { gt: 1 } } } any field — it is aggregated
 *
 * The second is legal SQL for the same reason it is legal Prisma: `count(email)`
 * has one value per group whether or not `email` is grouped. Measured against a
 * live client rather than inferred from the refusal of the first — reading that
 * message as "the field must be in `by`" would have refused a query Prisma
 * accepts, which is how this was nearly written.
 */
function havingField(
  schema: ModelSchema,
  op: string,
  name: string,
  grouped: Grouped[],
  aggregated: boolean,
): FieldSchema {
  const field = resolveField(schema, op, "_count", name);
  if (aggregated) return field;
  if (grouped.some((column) => column.field.name === field.name)) return field;

  throw new UnsupportedQueryError(
    `having.${name}`,
    schema.name,
    op,
    `'${name}' is not in 'by'. A 'having' filter on a plain column needs the ` +
      `column to be grouped — a group has one value for those and many for ` +
      `everything else. Prisma refuses this too. Add '${name}' to 'by', ` +
      `aggregate it instead ('having: { ${name}: { _count: { … } } }'), or ` +
      `filter the rows with 'where' rather than the groups with 'having'.`,
  );
}

/**
 * An operand is one form or the other, never both.
 *
 * `having: { role: { gt: 0, _count: { gt: 1 } } }` reads as though it should
 * mean "the group's role is above 0 *and* it has more than one row", and there
 * is a sensible statement for it. Prisma does not produce that statement — its
 * query engine **panics**:
 *
 *     thread 'tokio-runtime-worker' panicked at
 *       query-engine/core/src/query_graph_builder/read/aggregations/group_by.rs:136
 *     internal error: entered unreachable code
 *
 * So there is nothing to match, and inventing a meaning would put gemi ahead of
 * Prisma on a shape Prisma cannot express — which is exactly where a
 * differential test has no oracle. Refused by name instead, with the spelling
 * that does work.
 */
function assertPureAggregate(
  schema: ModelSchema,
  op: string,
  name: string,
  operand: unknown,
): void {
  const extra = Object.keys(operand as Record<string, unknown>).filter(
    (key) => !(KINDS as readonly string[]).includes(key),
  );
  if (extra.length === 0) return;

  throw new UnsupportedQueryError(
    `having.${name}`,
    schema.name,
    op,
    `A 'having' filter is either a comparison on a grouped column or a filter ` +
      `on an aggregate of it, not both — this one mixes ` +
      `${extra.sort().join(", ")} with an aggregate. Prisma's query engine ` +
      `panics on this shape rather than answering it, so there is no ` +
      `behaviour to match. Use an 'AND' of the two filters instead.`,
  );
}

/** The comparison operators a `having` operand may use. */
const OPERATORS: Record<string, string> = {
  equals: "=",
  not: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

function comparison(
  lhs: string,
  operand: unknown,
  schema: ModelSchema,
  op: string,
  argument: string,
  locate: (args: any) => any,
  dialect: SqlDialect,
): Fragment {
  // A bare value is `equals`, the same shorthand `where` accepts.
  if (typeof operand !== "object" || operand === null || operand instanceof Date) {
    return concat(sql(`${lhs} = `), param((args) => dialect.encodeUntyped(locate(args))));
  }

  const source = operand as Record<string, unknown>;
  const parts: Fragment[] = [];

  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (value === undefined) continue;

    const operator = OPERATORS[key];
    if (!operator) {
      throw new UnsupportedQueryError(
        `${argument}.${key}`,
        schema.name,
        op,
        `A 'having' filter takes ${Object.keys(OPERATORS).sort().join(", ")}.`,
      );
    }

    if (value === null) {
      parts.push(sql(`${lhs} is ${key === "not" ? "not " : ""}null`));
      continue;
    }

    parts.push(
      concat(
        sql(`${lhs} ${operator} `),
        param((args) => dialect.encodeUntyped(locate(args)?.[key])),
      ),
    );
  }

  if (parts.length === 0) return sql("true");
  return parts.length === 1
    ? parts[0]
    : concat(sql("("), joinFragments(parts, " and "), sql(")"));
}

/**
 * `orderBy`, under the one restriction no other operation has.
 *
 * *"Every field used for orderBy must be included in the by-arguments of the
 * query"* — Prisma's own words, and the reason is that a group has one value
 * for a grouped column and many for everything else, so ordering by an
 * ungrouped column is a question with no answer. Reproduced rather than passed
 * through, because SQLite answers it anyway by picking an arbitrary row's
 * value, and a silently arbitrary order is worse than a refusal.
 *
 * An **aggregate** may be named — `orderBy: { _count: { role: "desc" } }` is
 * the top-N-by-count query — and it is the one ordering term that is a function
 * call rather than a column, which is why this does not go through
 * `parseOrderBy`.
 *
 * `orderBy` is *optional* here. #64 predicted Prisma would require it whenever
 * `by` is given; measured against a live client, `groupBy` with no `orderBy` at
 * all is accepted, so requiring one would have refused a legal query.
 */
function compileGroupOrdering(
  schema: ModelSchema,
  op: string,
  orderBy: unknown,
  grouped: Grouped[],
  dialect: SqlDialect,
): Fragment | null {
  if (orderBy === undefined || orderBy === null) return null;

  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new UnsupportedQueryError(
        "orderBy",
        schema.name,
        op,
        `Expected an object of fields, or an array of them.`,
      );
    }

    for (const key of Object.keys(entry)) {
      const value = (entry as Record<string, unknown>)[key];
      if (value === undefined) continue;

      if ((KINDS as readonly string[]).includes(key)) {
        parts.push(...aggregateOrdering(schema, op, key as Kind, value, dialect));
        continue;
      }

      const field = schema.fields[key];
      if (!field) {
        throw new UnknownFieldError(key, schema.name, Object.keys(schema.fields));
      }
      if (!grouped.some((column) => column.field.name === field.name)) {
        throw new UnsupportedQueryError(
          `orderBy.${key}`,
          schema.name,
          op,
          `'${key}' is not in 'by'. Every field an 'orderBy' names has to be ` +
            `one of the grouped columns, because a group has one value for ` +
            `those and many for everything else. Prisma refuses this too.`,
        );
      }

      parts.push(`${dialect.quoteIdent(field.column)} ${direction(schema, op, key, value)}`);
    }
  }

  if (parts.length === 0) return null;
  return sql(parts.join(", "));
}

function aggregateOrdering(
  schema: ModelSchema,
  op: string,
  kind: Kind,
  operand: unknown,
  dialect: SqlDialect,
): string[] {
  if (typeof operand !== "object" || operand === null || Array.isArray(operand)) {
    throw new UnsupportedQueryError(
      `orderBy.${kind}`,
      schema.name,
      op,
      `Expected an object of fields.`,
    );
  }

  const parts: string[] = [];
  const source = operand as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined) continue;

    if (kind === "_count" && key === "_all") {
      parts.push(`count(*) ${direction(schema, op, `${kind}._all`, value)}`);
      continue;
    }

    const field = resolveField(schema, op, kind, key);
    assertAggregable(schema, op, kind, field);
    parts.push(
      `${FUNCTION[kind]}(${dialect.quoteIdent(field.column)}) ` +
        `${direction(schema, op, `${kind}.${key}`, value)}`,
    );
  }

  return parts;
}

/** A direction is structural, never a parameter — the same rule `orderBy` has. */
function direction(schema: ModelSchema, op: string, at: string, value: unknown): string {
  if (value === "asc" || value === "desc") return value;
  throw new UnsupportedQueryError(
    `orderBy.${at}`,
    schema.name,
    op,
    `Expected 'asc' or 'desc', got ${JSON.stringify(value)}.`,
  );
}

function assertArgs(schema: ModelSchema, op: string, args: any): void {
  if (args === undefined || args === null || typeof args !== "object") {
    throw new UnsupportedQueryError(
      "by",
      schema.name,
      op,
      `groupBy requires 'by'.`,
    );
  }

  for (const key of Object.keys(args).sort()) {
    if (args[key] === undefined) continue;
    if (GROUP_BY_ARGS.has(key)) continue;
    throw new UnsupportedQueryError(key, schema.name, op);
  }

  if (args.by === undefined) {
    throw new UnsupportedQueryError(
      "by",
      schema.name,
      op,
      `groupBy requires 'by'.`,
    );
  }
}
