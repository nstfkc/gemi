import type { SqlDialect } from "../dialect";
import {
  InvalidArgumentError,
  UnknownRelationError,
  UnsupportedQueryError,
} from "../errors";
import type { ModelSchema, RelationSchema } from "../schema";
import { COUNT_KEY, countableRelations } from "../relation-filters";
import { type Fragment, concat, sql } from "./fragment";
import { correlate } from "./correlate";
import { compileWhere } from "./where";

/**
 * `include: { _count: { select: { accounts: true } } }` -> a correlated
 * `count(*)` in the select list.
 *
 * The last item iteration 3 listed as out of scope and never rescheduled. It is
 * the same machinery relation filters use — a correlated subquery over the child,
 * aliased so a self-relation cannot shadow the outer table — projected instead of
 * predicated:
 *
 *     select …, (select count(*) from "Account" as "_c0"
 *                where "_c0"."userId" = "User"."id") as "_count.accounts"
 *
 * One statement, no extra round trip, and no row multiplication: a `group by`
 * against a to-many would fold the parents together and a join would duplicate
 * them, which is the same reason relation filters are `exists` rather than joins.
 */

export interface CountPlan {
  /** The relation being counted, as the caller named it. */
  as: string;
  /** The projected column, aliased so `shape` can find it in the raw row. */
  column: Fragment;
  /** The alias, which is also the raw row's key. */
  alias: string;
}

/**
 * Reads `_count` out of an `include` or a `select`.
 *
 * Returns an empty list when there is none, which is the overwhelmingly common
 * case and costs one property read.
 */
export function planRelationCounts(
  schema: ModelSchema,
  args: any,
  dialect: SqlDialect,
  operation: string,
): CountPlan[] {
  const container = args?.include ?? args?.select;
  if (typeof container !== "object" || container === null) return [];

  const node = container[COUNT_KEY];
  if (node === undefined || node === false) return [];

  const selection = readCountSelection(schema, node, operation);
  const plans: CountPlan[] = [];

  // Sorted for the reason every walk here is: the plan cache canonicalises key
  // order, so two argument objects differing only in key order are one entry and
  // must produce one statement.
  for (const key of Object.keys(selection).sort()) {
    const value = selection[key];
    if (value === undefined || value === false) continue;

    const relation = schema.relations[key];
    if (!relation) {
      throw new UnknownRelationError(
        key,
        schema.name,
        Object.keys(schema.relations),
      );
    }

    plans.push(
      countPlan(schema, relation, value, dialect, operation, plans.length, args),
    );
  }

  return plans;
}

function countPlan(
  schema: ModelSchema,
  relation: RelationSchema,
  node: unknown,
  dialect: SqlDialect,
  operation: string,
  index: number,
  args: any,
): CountPlan {
  const path = `_count.select.${relation.name}`;

  if (relation.kind !== "many") {
    // Prisma only counts to-many relations, and the reason is that the answer is
    // 0 or 1 — which the relation's own nullability already says.
    throw new UnsupportedQueryError(
      path,
      schema.name,
      operation,
      `${relation.name} is a to-one relation. Counting it can only ever ` +
        `return 0 or 1, which is what its nullability already tells you.`,
    );
  }

  const source = correlate(
    schema,
    relation,
    dialect,
    `_c${index}`,
    `${dialect.quoteIdent(schema.table)}.`,
    operation,
  );

  const where = node === true ? undefined : (node as any)?.where;
  const container = args?.include !== undefined ? "include" : "select";
  const locate = (a: any) =>
    a?.[container]?.[COUNT_KEY]?.select?.[relation.name]?.where;

  const filter = compileWhere(
    source.child,
    where,
    { dialect, operation, qualifier: source.qualifier },
    locate,
  );

  const parts: Fragment[] = [
    sql(`(select count(*) from ${source.source} where ${source.correlation}`),
  ];
  if (filter) parts.push(sql(" and "), filter);
  // The alias carries a dot on purpose: it cannot collide with a column, since
  // an identifier that needs quoting to contain one could not have come from the
  // schema, and it keeps the raw row self-describing when a query is logged.
  parts.push(sql(`) as ${dialect.quoteIdent(`_count.${relation.name}`)}`));

  return {
    as: relation.name,
    alias: `_count.${relation.name}`,
    column: concat(...parts),
  };
}

/**
 * `_count: { select: { … } }`, or the `_count: true` shorthand expanded into it.
 *
 * The shorthand was refused until #394, and the refusal gave two reasons. The
 * first — "it names no relation, so a policy has nowhere to attach" — was about
 * *where* the expansion happens rather than whether it can: expanded here and
 * nowhere else, the policy walk would still see `true`, `scopeCounts` would
 * return it untouched, and every count would be unscoped. So `policy.ts` expands
 * it too, through the same `countableRelations`, and this stays the compiler's
 * own total-function copy for the same reason `include: { accounts: true }`
 * compiles when the compiler is called directly: scoping is `$exec`'s job,
 * uniformly, and the compiler compiles what it is handed.
 *
 * The second reason — what it returns changes when the schema grows a relation —
 * is true, and is Prisma's semantics rather than a defect this could fix. It is
 * documented at the shorthand in `docs/orm.md` instead of being answered with a
 * refusal.
 */
function readCountSelection(
  schema: ModelSchema,
  node: unknown,
  operation: string,
): Record<string, unknown> {
  if (node === true) {
    const countable = countableRelations(schema);

    // A model with nothing to count. Refused rather than answered with `{}`,
    // and not only for tidiness: `select: { _count: true }` alone would then
    // project no columns at all — `resolveSelection` counts `_count` as
    // something selected, so an empty expansion passes its "at least one field"
    // check and emits `select  from "User"`, which is not valid SQL.
    if (countable.length === 0) {
      throw new UnsupportedQueryError(
        "_count",
        schema.name,
        operation,
        `${schema.name} has no to-many relations, so there is nothing for ` +
          `'_count: true' to count.`,
      );
    }

    return Object.fromEntries(countable.map((name) => [name, true]));
  }

  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new InvalidArgumentError(
      "_count",
      schema.name,
      operation,
      "Expected an object holding 'select'.",
    );
  }

  const selection = (node as Record<string, unknown>).select;
  if (
    typeof selection !== "object" ||
    selection === null ||
    Array.isArray(selection)
  ) {
    throw new InvalidArgumentError(
      "_count.select",
      schema.name,
      operation,
      "Expected an object naming the relations to count.",
    );
  }

  return selection as Record<string, unknown>;
}

