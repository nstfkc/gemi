import type { SqlDialect } from "../dialect";
import type { FieldSchema, ModelSchema } from "../schema";
import { type Fragment, concat, sql } from "./fragment";
import {
  batchedStrategy,
  type RelationPlan,
  type RelationRequest,
  type RelationStrategy,
  relatedSchema,
  resolveLink,
} from "./plan-relations";
import { resolveSelection } from "./select";
import { compileOrderBy, parseOrderBy } from "./orderBy";
import { compileWhere } from "./where";

/**
 * `LATERAL` + `json_agg`: one round trip for a relation instead of one per node.
 *
 * Iteration 9. The measured case for it, from `plans/orm/benchmarks.md`: an include
 * costs one statement per node — 1, 2, 3 for no-include, depth-2, depth-3, counted
 * rather than timed — and on Postgres a round trip is the dominant cost of a small
 * query. Collapsing N statements into 1 removes `(N - 1)` round trips.
 *
 * ## What this version folds, and what it declines
 *
 * It **falls back to the batched plan** rather than emitting SQL it cannot get
 * right. Every decline is a correctness boundary, not a to-do:
 *
 * - **Not Postgres.** SQLite has `json_group_array`, but its round trips are
 *   in-process and cost tens of microseconds; nothing measured asks for it, and the
 *   plan says to build it only if something does.
 * - **A node with its own `include` or `select` of a relation.** Folding a whole
 *   tree into one statement is the headline win and it needs recursion through this
 *   same builder; folding only the outer level of a depth-3 tree still saves one
 *   round trip of two, which is why this is worth shipping before that.
 * - **An implicit many-to-many.** The join table needs a second lateral, and the
 *   self-referential case cannot say which column is which end — see the note in
 *   `plan-relations.ts`.
 *
 * Falling back per *node* rather than per query is what makes a mixed tree work:
 * `QueryPlan.strategies` then reports both names, which is why that field exists.
 *
 * ## Why the values are still parameters
 *
 * The subquery is built from `Fragment`s and its `where` goes through
 * `compileWhere`, so a node's filter binds exactly as a root filter does.
 * Invariant 2 applies to a strategy's SQL as much as to the compiler's own, and
 * this is the first strategy that emits any.
 */
export const lateralStrategy: RelationStrategy = {
  name: "lateral",

  plan(request: RelationRequest): RelationPlan {
    const batched = batchedStrategy.plan(request);
    const declined = decline(request);
    if (declined) return batched;

    const child = relatedSchema(request.parent, request.relation);
    const link = resolveLink(request.parent, child, request.relation);
    const node = normalise(request.node);

    const dialect = request.dialect;
    const many = request.relation.kind === "many";

    // An alias for the subquery, derived from the relation's key so two relations
    // on one query cannot collide. Not user input: `as` is a key on the generated
    // schema's `relations`, so it is an identifier the same way a column is.
    const alias = dialect.quoteIdent(`__lat_${request.as}`);
    const childTable = dialect.quoteIdent(child.table);
    const childQualifier = `${childTable}.`;

    const selected = resolveSelection(child, node, request.operation);
    const object = jsonObject(selected, childQualifier, dialect);

    // The correlation: the child's foreign key against the *parent's* column.
    // This is the whole of "lateral" — the subquery references the outer row.
    const correlation = sql(
      `${childQualifier}${dialect.quoteIdent(
        fieldOf(child, link.childField).column,
      )} = ${dialect.quoteIdent(request.parent.table)}.${dialect.quoteIdent(
        fieldOf(request.parent, link.parentField).column,
      )}`,
    );

    // `orderBy` on a relation node, which most real includes carry.
    //
    // Inside an aggregate it belongs to the aggregate — `json_agg(x order by y)` —
    // not to the subquery, because a bare `order by` beside an aggregate orders
    // the one row the aggregate produces and the children come back in whatever
    // order the scan found them. A to-one takes the ordinary clause, since it is
    // not aggregating.
    const terms = parseOrderBy(child, node?.orderBy, request.operation);
    const ordering = compileOrderBy(terms, dialect, childQualifier);

    const filter = compileWhere(
      child,
      node?.where,
      { dialect, operation: request.operation, qualifier: childQualifier },
      (args) => request.locate(args)?.where,
    );

    const payload = many
      ? // `coalesce`, because `json_agg` over zero rows returns NULL and an empty
        // to-many must shape to `[]`. Getting this wrong is the single most likely
        // divergence in the whole strategy, and the differential harness compares
        // key presence, so it would be caught — but it is cheaper to be right.
        concat(
          sql(`coalesce(json_agg(`),
          object,
          ordering ? concat(sql(" order by "), ordering) : sql(""),
          sql(`), '[]'::json)`),
        )
      : object;

    const subquery = concat(
      sql(`select `),
      payload,
      sql(` as ${dialect.quoteIdent("data")} from ${childTable} where `),
      correlation,
      filter ? concat(sql(" and "), filter) : sql(""),
      // A to-one must not aggregate, and must not return two rows into a scalar
      // subquery position if the data violates the relation's cardinality. Its
      // ordering is the ordinary clause; the aggregate's is inside `json_agg`
      // above.
      many || !ordering ? sql("") : concat(sql(" order by "), ordering),
      many ? sql("") : sql(" limit 1"),
    );

    return {
      ...batched,
      strategy: "lateral",
      root: {
        column: concat(
          sql(`${alias}.${dialect.quoteIdent("data")} as `),
          sql(dialect.quoteIdent(request.as)),
        ),
        join: concat(
          sql(` left join lateral (`),
          subquery,
          sql(`) as ${alias} on true`),
        ),
        decode: buildDecoder(selected, dialect, many),
      },
      // Unreachable: `attachRelations` skips a plan carrying `root`. Kept as a
      // loud failure rather than the batched loader, because reaching it would
      // mean the skip regressed and issuing the query would hide that.
      load: async () => {
        throw new Error(
          `${request.parent.name}.${request.as} was folded into the root ` +
            `statement, so it must not also be loaded. This means ` +
            `attachRelations stopped honouring RelationPlan.root.`,
        );
      },
    };
  },
};

/** Why this node cannot fold, or `undefined` if it can. */
function decline(request: RelationRequest): string | undefined {
  if (request.dialect.name !== "postgres") return "not postgres";

  const relation = request.parent.relations[request.as];
  if (relation?.joinTable) return "implicit many-to-many";

  const node = normalise(request.node);
  if (node === undefined) return undefined;

  // No `take` / `skip` check: the planner refuses those on a relation node before
  // a strategy is consulted (`assertNodeArgs`), so a decline for them would be
  // dead code. Worth stating, because `json_agg` being an aggregate means a
  // `limit` beside it would cap the aggregate row rather than the children — so
  // if per-relation pagination is ever supported, this strategy must decline it
  // or nest a second subselect.
  if (node.include !== undefined) return "nested include";

  // A relation inside the node's own `select` is a nested tree by another name.
  const select = node.select;
  if (typeof select === "object" && select !== null) {
    const child = relatedSchema(request.parent, request.relation);
    for (const key of Object.keys(select)) {
      if (key in child.relations && select[key]) return "nested select";
    }
  }

  return undefined;
}

function normalise(node: unknown): any {
  if (node === true || node === undefined || node === null) return undefined;
  if (typeof node !== "object" || Array.isArray(node)) return undefined;
  return node;
}

/**
 * `json_build_object('id', "Account"."id", …)` over the child's selected columns.
 *
 * Keys are the *field* names, so the JSON arrives already shaped the way the
 * caller expects and the decoder does not have to map columns back. Both sides
 * come from the generated schema.
 */
function jsonObject(
  fields: readonly FieldSchema[],
  qualifier: string,
  dialect: SqlDialect,
): Fragment {
  const parts = fields.map((field) => {
    const column = `${qualifier}${dialect.quoteIdent(field.column)}`;
    // `::text` for BigInt, and this is a correctness fix rather than a
    // formality: JSON has no integer type, so `json_build_object` renders a
    // `bigint` as a JSON *number*, and `JSON.parse` turns that into a float64
    // before any decoder can see it. 9007199254740993 came back as
    // ...992 — the low bit gone, silently, in a value whose entire reason for
    // being a `BigInt` is that it does not fit a double.
    //
    // Casting in SQL means the value crosses as a string and `BigInt(string)` is
    // exact. Found by the all-scalars-through-a-relation fixture, which exists
    // because the template's schema has no BigInt behind a relation and the
    // differential matrix therefore cannot reach this.
    const expression = field.type === "BigInt" ? `${column}::text` : column;
    return `'${field.name}', ${expression}`;
  });
  return sql(`json_build_object(${parts.join(", ")})`);
}

/**
 * Turns the subquery's JSON into the rows the caller gets.
 *
 * **This is where the strategy earns or loses its correctness.** JSON aggregation
 * flattens types: a `timestamp` becomes an ISO string, `bytea` becomes a
 * `\\x`-prefixed hex string, `bigint` becomes a number or a string depending on
 * magnitude. The batched path never sees any of that, because its children come
 * back through the driver's own type mapping — so a decoder here that merely
 * `JSON.parse`s would return strings where Prisma returns `Date`s, and the
 * differential harness would catch it only for the types the template's schema
 * happens to use.
 *
 * So the conversion is driven by the child's *schema*, per field, and it reuses the
 * dialect's own `decode` for anything the dialect already knows how to convert.
 */
function buildDecoder(
  fields: readonly FieldSchema[],
  dialect: SqlDialect,
  many: boolean,
): (value: unknown) => unknown {
  const converters = fields
    .map((field) => ({ field, convert: jsonConverter(field) }))
    .filter((entry) => entry.convert !== undefined) as Array<{
    field: FieldSchema;
    convert: (value: unknown) => unknown;
  }>;

  const one = (row: unknown): unknown => {
    if (row === null || row === undefined || typeof row !== "object") return null;
    const record = row as Record<string, unknown>;
    for (const { field, convert } of converters) {
      record[field.name] = convert(record[field.name]);
    }
    return record;
  };

  return (value: unknown) => {
    // `jsonb` arrives parsed on some driver versions and as text on others; the
    // same `typeof` check `PostgresDialect.decode` uses handles both without a
    // version test.
    const parsed =
      typeof value === "string" ? safeParse(value) : (value ?? null);

    if (many) {
      if (!Array.isArray(parsed)) return [];
      return parsed.map(one).filter((row) => row !== null);
    }

    return one(parsed);
  };
}

/**
 * How one field's JSON form becomes its JavaScript form, or `undefined` when JSON
 * already carries it faithfully (`Int`, `String`, `Boolean`, `Float`, `Json`).
 */
function jsonConverter(
  field: FieldSchema,
): ((value: unknown) => unknown) | undefined {
  switch (field.type) {
    case "DateTime":
      // ISO text out of `json_build_object`, where the driver would have given a
      // `Date`. Prisma returns a `Date`, so this is not optional.
      return (value) =>
        value === null || value === undefined
          ? null
          : value instanceof Date
            ? value
            : new Date(String(value));

    case "BigInt":
      return (value) =>
        value === null || value === undefined ? null : BigInt(String(value));

    case "Json":
      // A `jsonb` column embedded in `json_build_object` should arrive as a
      // nested object, and does — unless the value was stored as a JSON *string*,
      // which is what `PostgresDialect.encode` produces and what the column then
      // holds if it is text-typed rather than `jsonb`. The batched path handles
      // exactly this with the same `typeof` check in `PostgresDialect.decode`, so
      // the two paths agree either way rather than only when the column type is
      // what one of them assumed.
      return (value) => {
        if (value === null || value === undefined) return null;
        if (typeof value !== "string") return value;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      };

    case "Bytes":
      // Postgres renders `bytea` into JSON as `\x` followed by hex.
      return (value) => {
        if (value === null || value === undefined) return null;
        if (ArrayBuffer.isView(value)) return value;
        const text = String(value).replace(/^\\?x/, "");
        const bytes = new Uint8Array(text.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
      };

    default:
      return undefined;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fieldOf(schema: ModelSchema, name: string): FieldSchema {
  const field = schema.fields[name];
  if (!field) {
    throw new Error(
      `${schema.name} has no field '${name}', which the lateral strategy needs ` +
        `to correlate on. This means the generated artifact is stale.`,
    );
  }
  return field;
}
