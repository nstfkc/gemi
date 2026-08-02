import type { SqlDialect } from "../dialect";
import { COUNT_KEY } from "../relation-filters";
import type { FieldSchema, ModelSchema, RelationSchema } from "../schema";
import { type Binder, type Fragment, concat, sql } from "./fragment";
import {
  assertPaginable,
  batchedStrategy,
  type FoldedRelation,
  type Link,
  type RelationPlan,
  type RelationRequest,
  type RelationStrategy,
  relatedSchema,
  relationNodes,
  resolveLink,
} from "./plan-relations";
import { resolveSelection } from "./select";
import { compileOrderBy, parseOrderBy, reverse, type OrderTerm } from "./orderBy";
import { compileWhere } from "./where";

/**
 * `LATERAL` + `json_agg`: one round trip for a whole include *tree* instead of
 * one per node.
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
 * - **An implicit many-to-many.** The join table needs a second lateral, and the
 *   self-referential case cannot say which column is which end — see the note in
 *   `plan-relations.ts`.
 * - **A self-relation**, where the child and the parent are the same table: the
 *   correlation is written as `"T"."fk" = "T"."pk"`, which inside the subquery
 *   refers to the subquery's own row rather than the outer one. Expressing it
 *   needs an alias in the `from` clause, and the batched strategy already handles
 *   it correctly.
 * - **A `_count` on a node.** It projects a correlated subquery that
 *   `planRelationCounts` owns at the *root* of a statement, and a folded node has
 *   no root of its own.
 *
 * A node whose subtree contains any of those declines as a whole, because half a
 * fold is not a thing: the children come back as JSON in the parent's row and
 * never enter the related model's `$exec`, so a descendant that cannot fold has
 * nowhere to be loaded from. Declining the node instead sends the *whole* subtree
 * back through `$exec`, where the strategy is applied again one level down — so a
 * decline costs one statement, not the subtree.
 *
 * Falling back per *node* rather than per query is what makes a mixed tree work:
 * `QueryPlan.strategies` then reports both names, which is why that field exists.
 *
 * ## Per-parent `take` / `skip`
 *
 * This is the strategy that can express them, and the only one. `json_agg` is an
 * aggregate, so a `limit` beside it would cap the aggregate's single row rather
 * than the children — the page has to happen *before* the aggregate, in a
 * subquery of its own. The ordering terms are carried out of that subquery as
 * `__ord_N` columns so the aggregate can re-apply them: aggregating over an
 * ordered subquery and hoping the order survives is not something Postgres
 * promises.
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
    const declined = decline(
      request.parent,
      request.relation,
      request.as,
      request.node,
      request.dialect,
      request.operation,
    );

    if (declined) {
      // Raised here rather than left to the batched plan, because *why* this
      // node reached a strategy that cannot page it is the actionable half of
      // the message and only this function knows it.
      assertPaginable(request, `this node declined to fold (${declined})`);
      return batchedStrategy.plan(request);
    }

    const { dialect } = request;
    const child = relatedSchema(request.parent, request.relation, request.as);
    const link = resolveLink(
      request.parent,
      child,
      request.relation,
      request.operation,
    );

    const fold = foldNode({
      parent: request.parent,
      child,
      relation: request.relation,
      as: request.as,
      node: request.node,
      locate: request.locate,
      link,
      dialect,
      operation: request.operation,
      depth: 1,
      counter: { next: 0 },
    });

    return {
      as: request.as,
      model: request.relation.model,
      kind: request.relation.kind,
      parentFields: link.parentFields,
      strategy: "lateral",
      root: {
        column: concat(
          sql(`${fold.alias}.${dialect.quoteIdent("data")} as `),
          sql(dialect.quoteIdent(request.as)),
        ),
        join: concat(
          sql(` left join lateral (`),
          fold.subquery,
          sql(`) as ${fold.alias} on true`),
        ),
        decode: fold.decode,
        folded: fold.folded,
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

/**
 * Why this node — or anything below it — cannot fold, or `undefined` if it can.
 *
 * Recursive, because folding is: a descendant that cannot be expressed has
 * nowhere to be loaded from once its ancestors are JSON in a parent row.
 */
function decline(
  parent: ModelSchema,
  relation: RelationSchema,
  as: string,
  node: unknown,
  dialect: SqlDialect,
  operation: string,
): string | undefined {
  if (dialect.name !== "postgres") return "not postgres";
  if (relation.joinTable) return "implicit many-to-many";

  const child = relatedSchema(parent, relation, as);
  // The correlation names both tables, so a relation onto the same table would
  // compare the subquery's own row against itself.
  if (child.table === parent.table) return "self-relation";

  const args = normalise(node);
  if (args === undefined) return undefined;

  // `_count` sits in the same container as the relation nodes and is skipped by
  // every walk over it, so a node carrying one would fold *without* it and
  // return rows missing a key the caller asked for.
  if (hasCount(args)) return "_count on a folded node";

  // `orderBy: { user: { email: "asc" } }` on a node compiles to a correlated
  // subquery, and `foldNode` parses the node's `orderBy` with no `OrderContext`
  // to build one with — so `parseOrderBy` raises rather than emitting anything.
  // Declining sends the node to the batched strategy, which compiles the
  // ordering as part of the child's own query and gets it right.
  //
  // It reads like the `_count` case above and is the same shape: a node that
  // would fold *without* something the caller asked for has to decline instead.
  // Supporting it properly means threading an `OrderContext` down through
  // `foldNode` so `order-relation.ts` can build the subquery against the child's
  // qualifier — a bigger change than this one, and one that owes the
  // differential harness its own coverage.
  if (ordersByRelation(child, args.orderBy)) {
    return "relation ordering on a folded node";
  }

  for (const nested of relationNodes(child, args, operation)) {
    const reason = decline(
      child,
      nested.relation,
      nested.as,
      nested.node,
      dialect,
      operation,
    );
    if (reason) return `${nested.as}: ${reason}`;
  }

  return undefined;
}

/**
 * Whether an `orderBy` sorts by a *relation* rather than by a column.
 *
 * Both of Prisma's relation-ordering forms name the relation as the key —
 * `{ organization: { name: "asc" } }` and `{ accounts: { _count: "desc" } }` —
 * so the check is the same one `parseOrderBy` makes, and both of its accepted
 * containers (one object, or an array of them) are walked.
 */
function ordersByRelation(schema: ModelSchema, orderBy: unknown): boolean {
  if (orderBy === undefined || orderBy === null) return false;

  for (const entry of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    if (typeof entry !== "object" || entry === null) continue;
    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined) continue;
      if (key in schema.relations) return true;
    }
  }

  return false;
}

function hasCount(args: Record<string, unknown>): boolean {
  for (const container of ["include", "select"] as const) {
    const tree = args[container];
    if (typeof tree !== "object" || tree === null || Array.isArray(tree)) {
      continue;
    }
    const count = (tree as Record<string, unknown>)[COUNT_KEY];
    if (count !== undefined && count !== false) return true;
  }
  return false;
}

interface FoldInput {
  /** The table the correlation compares against — one level out. */
  parent: ModelSchema;
  child: ModelSchema;
  relation: RelationSchema;
  as: string;
  node: unknown;
  /** Re-locates *this* node inside the whole call's argument tree. */
  locate: (args: any) => any;
  link: Link;
  dialect: SqlDialect;
  operation: string;
  depth: number;
  /**
   * Hands out one index per node in this subtree, so a nested alias cannot
   * shadow an ancestor's. Depth 1 keeps the bare `__lat_<relation>` form, which
   * is the one a query log is read with.
   */
  counter: { next: number };
}

interface Fold {
  /** Quoted, and unique within the statement it is emitted into. */
  alias: string;
  subquery: Fragment;
  decode: (value: unknown) => unknown;
  folded: FoldedRelation[];
}

/**
 * One relation node as a correlated subquery, with everything below it folded in.
 */
function foldNode(input: FoldInput): Fold {
  const { dialect, child, operation } = input;
  const node = normalise(input.node);
  const many = input.relation.kind === "many";

  const index = input.counter.next++;
  const alias = dialect.quoteIdent(suffixed("__lat_", input.as, input.depth, index));
  const childTable = dialect.quoteIdent(child.table);
  const childQualifier = `${childTable}.`;

  const selected = resolveSelection(child, node, operation);

  // Everything below this node, folded into the same subquery. Their joins go
  // in this level's `from`, and their `data` columns into this level's object.
  const nested = relationNodes(child, node, operation).map((relationNode) => {
    const grandchild = relatedSchema(child, relationNode.relation, relationNode.as);
    return {
      as: relationNode.as,
      relation: relationNode.relation,
      fold: foldNode({
        parent: child,
        child: grandchild,
        relation: relationNode.relation,
        as: relationNode.as,
        node: relationNode.node,
        // Composed rather than captured: the plan is compiled once per argument
        // *shape*, so a nested `where`'s values are read from the call through
        // the whole chain of `locate`s.
        locate: (args: any) => relationNode.locate(input.locate(args)),
        link: resolveLink(child, grandchild, relationNode.relation, operation),
        dialect,
        operation,
        depth: input.depth + 1,
        counter: input.counter,
      }),
    };
  });

  const object = jsonObject(
    selected,
    childQualifier,
    dialect,
    nested.map((entry) => ({ key: entry.as, alias: entry.fold.alias })),
  );

  const joins = concat(
    ...nested.map((entry) =>
      concat(
        sql(` left join lateral (`),
        entry.fold.subquery,
        sql(`) as ${entry.fold.alias} on true`),
      ),
    ),
  );

  // The correlation: the child's foreign key against the *parent's* column.
  // This is the whole of "lateral" — the subquery references the outer row —
  // and one equality per joined field is the whole of composite support here.
  const correlation = sql(
    input.link.parentFields
      .map(
        (parentField, index) =>
          `${childQualifier}${dialect.quoteIdent(
            fieldOf(child, input.link.childFields[index]).column,
          )} = ${dialect.quoteIdent(input.parent.table)}.${dialect.quoteIdent(
            fieldOf(input.parent, parentField).column,
          )}`,
      )
      .join(" and "),
  );

  const filter = compileWhere(
    child,
    node?.where,
    { dialect, operation, qualifier: childQualifier },
    (args) => input.locate(args)?.where,
  );

  const scan = concat(
    sql(` from ${childTable}`),
    joins,
    sql(` where `),
    correlation,
    filter ? concat(sql(" and "), filter) : sql(""),
  );

  const decode = buildDecoder(
    selected,
    dialect,
    many,
    nested.map((entry) => ({ key: entry.as, decode: entry.fold.decode })),
  );

  const folded: FoldedRelation[] = nested.map((entry) => ({
    as: entry.as,
    model: entry.relation.model,
    kind: entry.relation.kind,
    folded: entry.fold.folded,
  }));

  const terms = parseOrderBy(child, node?.orderBy, operation);

  if (!many) {
    // A to-one must not aggregate, and must not return two rows into a scalar
    // subquery position if the data violates the relation's cardinality. It
    // takes no `orderBy` — the planner refuses one — so there is nothing to
    // order by either.
    return {
      alias,
      folded,
      decode,
      subquery: concat(
        sql(`select `),
        object,
        sql(` as ${dialect.quoteIdent("data")}`),
        scan,
        sql(" limit 1"),
      ),
    };
  }

  const page = pagination(input, node, terms, child);

  if (!page) {
    // `coalesce`, because `json_agg` over zero rows returns NULL and an empty
    // to-many must shape to `[]`. Getting this wrong is the single most likely
    // divergence in the whole strategy, and the differential harness compares
    // key presence, so it would be caught — but it is cheaper to be right.
    //
    // The ordering belongs to the aggregate — `json_agg(x order by y)` — not to
    // the subquery: a bare `order by` beside an aggregate orders the one row the
    // aggregate produces, and the children come back in whatever order the scan
    // found them.
    const ordering = compileOrderBy(terms, dialect, childQualifier);
    return {
      alias,
      folded,
      decode,
      subquery: concat(
        sql(`select coalesce(json_agg(`),
        object,
        ordering ? concat(sql(" order by "), ordering) : sql(""),
        sql(`), '[]'::json) as ${dialect.quoteIdent("data")}`),
        scan,
      ),
    };
  }

  // Paginated: the page has to be taken *before* the aggregate, so the scan goes
  // into a subquery of its own and the aggregate runs over its rows.
  const pageAlias = dialect.quoteIdent(
    suffixed("__page_", input.as, input.depth, index),
  );

  // The ordering columns, carried out of the page so the aggregate can re-apply
  // them. Aliased rather than repeated, which also lets the inner `order by`
  // name them — Postgres resolves an `order by` against the select list.
  const carried = page.terms.map((term, position) =>
    sql(
      `, ${childQualifier}${dialect.quoteIdent(term.column)} as ` +
        `${dialect.quoteIdent(orderAlias(position))}`,
    ),
  );

  const inner = compileOrderBy(aliased(page.inner), dialect);
  const outer = compileOrderBy(aliased(page.terms), dialect, `${pageAlias}.`);

  return {
    alias,
    folded,
    decode,
    subquery: concat(
      sql(`select coalesce(json_agg(${pageAlias}.${dialect.quoteIdent("data")}`),
      outer ? concat(sql(" order by "), outer) : sql(""),
      sql(`), '[]'::json) as ${dialect.quoteIdent("data")} from (select `),
      object,
      sql(` as ${dialect.quoteIdent("data")}`),
      ...carried,
      scan,
      inner ? concat(sql(" order by "), inner) : sql(""),
      page.clause,
      sql(`) as ${pageAlias}`),
    ),
  };
}

/**
 * The node's own `take` / `skip`, or `undefined` when it has neither.
 *
 * Mirrors the root's `pagination` in `read.ts`, including the two pieces of
 * Prisma behaviour that are invisible until you read the SQL it emits:
 *
 * - Paginating without an `orderBy` orders by the primary key. Without it,
 *   "the first ten" is only meaningful if the scan happens to be stable.
 * - A *negative* `take` means "the last N": every ordering term is flipped and
 *   `abs(take)` rows are taken. Here the page is put back into the caller's own
 *   order by the aggregate rather than by reversing an array, since the
 *   aggregate is already ordering — `inner` is the flipped order, `terms` is
 *   the one the caller asked for.
 */
function pagination(
  input: FoldInput,
  node: Record<string, any> | undefined,
  parsed: OrderTerm[],
  child: ModelSchema,
): { clause: Fragment; terms: OrderTerm[]; inner: OrderTerm[] } | undefined {
  const take = node?.take;
  const skip = node?.skip;
  if (take === undefined && skip === undefined) return undefined;

  const terms =
    parsed.length > 0
      ? parsed
      : child.primaryKey.map((name) => ({
          column: child.fields[name]?.column ?? name,
          direction: "asc" as const,
        }));

  const takeBinder: Binder | null =
    take === undefined
      ? null
      : (args: any) => Math.abs(Number(input.locate(args)?.take));

  const skipBinder: Binder | null =
    skip === undefined ? null : (args: any) => Number(input.locate(args)?.skip);

  return {
    clause: input.dialect.paginate(takeBinder, skipBinder),
    terms,
    inner: typeof take === "number" && take < 0 ? reverse(terms) : terms,
  };
}

const orderAlias = (position: number) => `__ord_${position}`;

/**
 * The same terms, pointed at the carried `__ord_N` columns rather than at the
 * child's own. Position is what ties the two together, so this must be mapped
 * from the same array the columns were carried from.
 */
function aliased(terms: OrderTerm[]): OrderTerm[] {
  return terms.map((term, position) => ({
    ...term,
    column: orderAlias(position),
    expression: undefined,
  }));
}

/**
 * An alias derived from the relation's key, so two relations on one query cannot
 * collide. Not user input: `as` is a key on the generated schema's `relations`,
 * so it is an identifier the same way a column is.
 *
 * Below the first level it carries the node's index too. Without it a tree that
 * reaches the same relation name twice — `accounts.user.accounts` — would emit
 * one alias inside another of the same name, where the inner silently shadows
 * the outer.
 */
function suffixed(
  prefix: string,
  as: string,
  depth: number,
  index: number,
): string {
  return depth === 1 ? `${prefix}${as}` : `${prefix}${as}_${index}`;
}

function normalise(node: unknown): any {
  if (node === true || node === undefined || node === null) return undefined;
  if (typeof node !== "object" || Array.isArray(node)) return undefined;
  return node;
}

/**
 * `json_build_object('id', "Account"."id", …)` over the child's selected columns,
 * followed by whatever relations folded below it.
 *
 * Keys are the *field* names, so the JSON arrives already shaped the way the
 * caller expects and the decoder does not have to map columns back. Both sides
 * come from the generated schema.
 */
function jsonObject(
  fields: readonly FieldSchema[],
  qualifier: string,
  dialect: SqlDialect,
  nested: readonly { key: string; alias: string }[],
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
    //
    // `::text[]` for a `BigInt[]`, and the measurement is the same one: a
    // `bigint[]` rendered into JSON is an array of JSON numbers, and
    // 9007199254740993 came back as ...992 element-wise. The array form of the
    // same trap, and it needs the array form of the same cast.
    const expression =
      field.type === "BigInt" ? `${column}::text${field.isList ? "[]" : ""}` : column;
    return `'${field.name}', ${expression}`;
  });

  // A folded relation is already JSON — an array from its own `json_agg`, or an
  // object from its own `json_build_object` — so it embeds as a value rather
  // than being re-encoded.
  for (const entry of nested) {
    parts.push(`'${entry.key}', ${entry.alias}.${dialect.quoteIdent("data")}`);
  }

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
 * A folded relation arrived nested inside this one's JSON, so its own decoder
 * runs from here — the same recursion the SQL took, in the other direction.
 */
function buildDecoder(
  fields: readonly FieldSchema[],
  dialect: SqlDialect,
  many: boolean,
  nested: readonly { key: string; decode: (value: unknown) => unknown }[],
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
    for (const child of nested) {
      record[child.key] = child.decode(record[child.key]);
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
 *
 * A **scalar list** is the element's own converter mapped over a JSON array,
 * which is exactly right and is worth saying because the alternative is
 * tempting: `PostgresDialect.decode` is *not* reusable here. Its whole job is
 * normalising the containers Bun's driver produces — an `Int32Array`, an
 * unparsed `{a,b}` literal — and none of them exist on this path. `json_agg`
 * hands over a JSON array whatever the element type, including for the enum
 * lists the driver refuses to parse. Two decoding sites, two container
 * problems, one shared per-element rule.
 */
function jsonConverter(
  field: FieldSchema,
): ((value: unknown) => unknown) | undefined {
  if (field.isList) {
    const element = elementConverter(field);
    if (!element) return undefined;
    return (value) => {
      if (value === null || value === undefined) return null;
      if (!Array.isArray(value)) return value;
      return value.map((item) =>
        item === null || item === undefined ? null : element(item),
      );
    };
  }

  return elementConverter(field);
}

function elementConverter(
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
      // Nothing to do, for the same reason `PostgresDialect.decode` does
      // nothing: the value arrives already parsed. A `jsonb` column embedded in
      // `json_build_object` is a nested JSON value, and Bun parses the whole
      // `data` payload — so by the time it reaches here it is an object, an
      // array, a string, a number or null, exactly as stored.
      //
      // This used to re-parse anything that was a string, on the reasoning that
      // it might be raw JSON text. **A JS string is ambiguous** between "text
      // nobody parsed" and "a JSON string value somebody did", and here the
      // ambiguity is worse than on the batched path, because the value has been
      // through JSON *twice* — once for the column, once for `json_agg`. A
      // column holding the JSON string `"42"` came back as the number 42 from a
      // folded include and as `"42"` from a batched one: the same query, two
      // answers, decided by which strategy the dialect happened to pick.
      //
      // Caught by seeding a JSON string one relation down. Nothing reached it
      // before, because the template's schema had no `Json` column at all.
      return undefined;

    case "Bytes":
      // Postgres renders `bytea` into JSON as `\x` followed by hex.
      //
      // **`Uint8Array`, not `Buffer`**, and the container matters as much as
      // the contents — see `PostgresDialect.decode`, which normalises the
      // driver's `Buffer` to the same thing for the batched path. Prisma 6
      // returns `Uint8Array` on every dialect; that is the contract, and
      // `Buffer.prototype.toString("hex")` versus
      // `Uint8Array.prototype.toString("hex")` is the observable difference.
      //
      // `Buffer.from(text, "hex")` for the parse — it is the parser the driver
      // would have used, and faster than a manual nibble loop — then a view
      // over the same bytes. No copy.
      return (value) => {
        if (value === null || value === undefined) return null;
        if (ArrayBuffer.isView(value)) {
          return Buffer.isBuffer(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : value;
        }
        const buffer = Buffer.from(String(value).replace(/^\\?x/, ""), "hex");
        return new Uint8Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength,
        );
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
