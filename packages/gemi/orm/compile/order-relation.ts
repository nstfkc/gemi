import type { SqlDialect } from "../dialect";
import { UnsupportedQueryError } from "../errors";
import { COUNT_KEY } from "../relation-filters";
import type { ModelSchema, RelationSchema } from "../schema";
import { type Fragment, concat, sql } from "./fragment";
import { correlate } from "./correlate";
import { compileWhere } from "./where";

/**
 * `orderBy: { organization: { name: "asc" } }` and
 * `orderBy: { accounts: { _count: "desc" } }`.
 *
 * The third use of the same correlated subquery — after `exists` for relation
 * filters and `count(*)` for `_count` — this time as a scalar in the `order by`
 * clause:
 *
 *     order by (select "_o0"."name" from "Organization" as "_o0"
 *               where "_o0"."id" = "User"."organizationId") asc
 *
 * A subquery rather than the `left join` Prisma emits, for the reason the other
 * two are subqueries: a join changes what the `from` clause contains, and on a
 * to-many it changes the row count. Ordering must not be able to do either. The
 * cost is that the subquery runs per row, which is the same index dependency the
 * benchmarks measured for `_count` — one `@@index` on the child's foreign key,
 * worth 6.3× there.
 *
 * ### The scope has nowhere to live in Prisma's shape, so we add one
 *
 * Every other path that reaches another model's rows carries a `where` the
 * policy walk can narrow: an `include` node has one, a relation filter's
 * operand is one, a `_count` entry takes one. `orderBy: { rel: { field: "asc" } }`
 * has none — Prisma's grammar has no slot for it.
 *
 * It still needs one. Ordering by a column of rows the caller cannot read leaks
 * their contents by comparison, and ordering by `_count` leaks their number
 * outright. So the policy walk writes `where` into this node, and this compiler
 * reads it. That key is **not** in Prisma's `orderBy` type, so the generated
 * bases — which type `args` as Prisma's own — cannot accept it from application
 * code. It is reachable only from the policy pass, which is the only thing that
 * should produce it.
 */

export interface RelationOrdering {
  expression: Fragment;
  direction: "asc" | "desc";
  nulls?: "first" | "last";
}

export function relationOrderExpression(
  schema: ModelSchema,
  relation: RelationSchema,
  value: unknown,
  operation: string,
  dialect: SqlDialect,
  locate: (args: any) => any,
  index: number,
): RelationOrdering {
  const path = `orderBy.${relation.name}`;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnsupportedQueryError(
      path,
      schema.name,
      operation,
      relation.kind === "many"
        ? `Expected { _count: "asc" | "desc" }.`
        : `Expected an object naming one field of ${relation.model}.`,
    );
  }

  const node = value as Record<string, unknown>;
  // `where` is the policy walk's, not the caller's — see the note above.
  const keys = Object.keys(node).filter((key) => key !== "where");

  if (keys.length !== 1) {
    throw new UnsupportedQueryError(
      path,
      schema.name,
      operation,
      keys.length === 0
        ? `Name the field to order by.`
        : `Name exactly one field to order by; got ${keys.join(", ")}. ` +
          `Order by several with an array: [{ a: … }, { b: … }].`,
    );
  }

  const [key] = keys;
  const source = correlate(
    schema,
    relation,
    dialect,
    `_o${index}`,
    `${dialect.quoteIdent(schema.table)}.`,
  );

  const selected = projection(
    schema,
    relation,
    source.child,
    key,
    node[key],
    operation,
    source.qualifier,
    dialect,
  );

  const filter = compileWhere(
    source.child,
    node.where,
    { dialect, operation, qualifier: source.qualifier },
    (args) => locate(args)?.where,
  );

  const parts: Fragment[] = [
    sql(
      `(select ${selected.expression} from ${source.source} ` +
        `where ${source.correlation}`,
    ),
  ];
  if (filter) parts.push(sql(" and "), filter);
  parts.push(sql(")"));

  return {
    expression: concat(...parts),
    direction: selected.direction,
    nulls: selected.nulls,
  };
}

/**
 * What the subquery selects, and which way it sorts.
 *
 * A to-many can only be ordered by `_count`; a to-one only by one of its own
 * fields. Both refuse the other's form rather than reinterpreting it — ordering
 * a to-one by `_count` would be ordering by 0 or 1, and ordering a to-many by a
 * field has no single answer for a parent with several children.
 */
function projection(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  key: string,
  value: unknown,
  operation: string,
  qualifier: string,
  dialect: SqlDialect,
): { expression: string; direction: "asc" | "desc"; nulls?: "first" | "last" } {
  const path = `orderBy.${relation.name}.${key}`;
  const { direction, nulls } = readDirection(schema, path, value, operation);

  if (key === COUNT_KEY) {
    if (relation.kind !== "many") {
      throw new UnsupportedQueryError(
        path,
        schema.name,
        operation,
        `${relation.name} is a to-one relation, so its count is 0 or 1. ` +
          `Order by one of ${child.name}'s fields instead.`,
      );
    }
    return { expression: "count(*)", direction, nulls };
  }

  if (relation.kind === "many") {
    throw new UnsupportedQueryError(
      path,
      schema.name,
      operation,
      `${relation.name} is a to-many relation, so ordering by '${key}' has no ` +
        `single answer for a parent with several children. Only ` +
        `{ _count: … } is supported.`,
    );
  }

  const field = child.fields[key];
  if (!field) {
    throw new UnsupportedQueryError(
      path,
      schema.name,
      operation,
      `'${key}' is not a field on ${child.name}. Known fields: ` +
        `${Object.keys(child.fields).join(", ")}.`,
    );
  }

  return {
    expression: `${qualifier}${dialect.quoteIdent(field.column)}`,
    direction,
    nulls,
  };
}

/** The same three forms `parseOrderBy` accepts for a column. */
function readDirection(
  schema: ModelSchema,
  path: string,
  value: unknown,
  operation: string,
): { direction: "asc" | "desc"; nulls?: "first" | "last" } {
  if (value === "asc" || value === "desc") return { direction: value };

  if (typeof value === "object" && value !== null) {
    const { sort, nulls } = value as Record<string, unknown>;
    if (sort !== "asc" && sort !== "desc") {
      throw new UnsupportedQueryError(
        path,
        schema.name,
        operation,
        'Expected "asc" or "desc".',
      );
    }
    if (nulls === undefined) return { direction: sort };
    if (nulls !== "first" && nulls !== "last") {
      throw new UnsupportedQueryError(
        `${path}.nulls`,
        schema.name,
        operation,
        'Expected "first" or "last".',
      );
    }
    return { direction: sort, nulls };
  }

  throw new UnsupportedQueryError(
    path,
    schema.name,
    operation,
    'Expected "asc", "desc", or { sort, nulls }.',
  );
}

