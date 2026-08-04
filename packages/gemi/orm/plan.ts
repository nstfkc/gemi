import { compile } from "./compile";
import type { BindContext } from "./compile/fragment";
import type { NestedWriteStep, RelationPlan } from "./compile/plan-relations";
import type { SqlDialect } from "./dialect";
import { jsonNullKind } from "./json-null";
import type { RelationStrategy } from "./compile/plan-relations";
import type { ModelSchema } from "./schema";

/**
 * The public operations. The raw operations are deliberately not among them:
 * they are excluded at the operation level rather than narrowed out of the
 * argument types, because narrowing Prisma's recursive where-inputs with `Omit`
 * is miserable.
 *
 * `aggregate` joined the list once there was a measured account of what Prisma
 * returns for one — see `compile/aggregate.ts`. `groupBy` followed in its own
 * change, for the reason this note gave for separating them: `having` is a
 * second predicate compiler over aggregate expressions rather than columns, and
 * `orderBy` carries a restriction no other operation has. See
 * `compile/group-by.ts`.
 */
export type Operation =
  | "findUnique"
  | "findUniqueOrThrow"
  | "findFirst"
  | "findFirstOrThrow"
  | "findMany"
  | "count"
  | "aggregate"
  | "groupBy"
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "upsert"
  | "delete"
  | "deleteMany";

/**
 * Per-call options that are *not* part of the query.
 *
 * A second parameter rather than a key inside `args`, deliberately: `args` is
 * typed as Prisma's own `FindManyArgs` and friends, and intersecting every one
 * of them with a gemi-specific key would mean `Prisma.UserFindManyArgs` no longer
 * describes what the operation accepts. Keeping it outside leaves those types
 * usable verbatim, which is the DX parity the project is built on.
 *
 * It also keeps the plan cache honest: these do not affect the SQL, so they must
 * not affect the plan key, and they cannot if they never reach the compiler.
 */
export interface ExecOptions {
  /**
   * Which relation strategy loads this query's `include` tree.
   *
   * `"batched"` issues one query per include node; `"lateral"` folds them into
   * the root statement with a `LATERAL` join on Postgres, declining per node for
   * anything it cannot express. Omitted, `defaultStrategy` chooses.
   *
   * Unlike `track`, this **does** reach the compiler and **is** part of the plan
   * key — two strategies emit different SQL for the same arguments, so sharing a
   * plan between them would run one query's statement for the other's request.
   * That is the one thing a per-call option must not do, which is why this one is
   * threaded rather than kept out of the way like `track` is.
   */
  strategy?: "batched" | "lateral";
  /**
   * Record where each returned row came from, so `Model.save(row)` can update it.
   *
   * Off by default: it costs a `WeakMap` insert and a snapshot clone per row, and
   * iteration 7 measured shaping at ~55µs per 1000 rows — so the default path
   * does not pay for a feature most queries do not use.
   */
  track?: boolean;
}

/**
 * The output of compilation. `text` is a pure function of the argument
 * *shape*; `bind` is the only thing that ever sees a value. Splitting them is
 * what makes the plan cacheable, what will let Postgres reuse prepared
 * statements, and what makes injection structurally impossible.
 */
export interface QueryPlan {
  text: string;
  bind(args: any, context?: BindContext): unknown[];
  shape(rows: unknown[]): unknown;
  /**
   * Nested-write steps that run before the statement, contributing foreign keys
   * into the bind context, and after it, writing rows that reference the one
   * just created. Both left undefined for a query with no nested writes.
   */
  before?: NestedWriteStep[];
  after?: NestedWriteStep[];
  /**
   * The relation nodes this query's `include` / `select` asks for, one plan per
   * node. Empty — and left undefined — for a query with no relations, so the
   * choke point can skip the whole stage with one check.
   */
  relations?: RelationPlan[];
  /**
   * Which relation strategies this plan's own nodes used, deduplicated and
   * sorted. Undefined when the query has no relations.
   *
   * Exists because a silent planner is untestable: once more than one strategy
   * can be chosen, "which one ran" has to be answerable from outside, both for
   * tests and for debugging a query that is slower than expected.
   *
   * **This plan's own nodes only, and that is not a limitation to remove.** A
   * nested level is loaded by `$exec` on the *child* model, which compiles its
   * own plan and chooses its own strategy — so a depth-3 include is three plans
   * with three independent answers, and asking the root for all of them would
   * mean reporting decisions that have not been made yet. It also means a mixed
   * tree is expressible, which is the point of the strategy being per-node.
   */
  strategies?: string[];
  /**
   * Fields the query had to select to stitch relations, but which the caller's
   * `select` did not ask for. Dropped once the relations are attached.
   */
  hidden?: string[];
  /**
   * Whether this plan projects a `_count`. Undefined when it does not.
   *
   * A write needs this for the same reason it needs `relations`: a `delete`
   * with either one is read *before* the row goes, so the choke point has to
   * know there is something to read. A count is not a relation plan — it is a
   * column in the statement, not a second query — so it cannot be discovered by
   * looking at `relations`, and `include: { _count: … }` on its own leaves that
   * list empty.
   */
  counts?: boolean;
}

/**
 * The cache is bounded because one part of the key space is *not* finite per
 * application: on SQLite an `in` list expands to one placeholder per element,
 * so every distinct list length is its own plan — and list length is routinely
 * request-derived (`?ids=1,2,3` off a query string) or, from iteration 3,
 * derived from the number of parent rows a relation is being loaded for.
 * Unbounded, that is a slow memory leak reachable from untrusted input.
 *
 * Postgres binds the whole list to one parameter, so there the length is not
 * part of the key at all — see `collapsedList`.
 *
 * A coarser key cannot fix the SQLite side: collapsing lengths there would hand
 * a plan the wrong number of placeholders. Eviction is the only correct answer.
 *
 * Least-recently-used, implemented on `Map`'s insertion ordering: re-inserting
 * on a hit moves the entry to the end, so the first key `keys().next()` yields
 * is always the coldest. A miss past the cap evicts exactly one entry. The cap
 * is far above any realistic application's distinct query shapes, so a
 * well-behaved app never evicts at all.
 */
const MAX_CACHED_PLANS = 1000;

const cache = new Map<string, QueryPlan>();
let compiles = 0;
let hits = 0;
let evictions = 0;

/**
 * A canonical description of an argument tree's *shape* — key paths, operators
 * and value kinds, never values. Keys are sorted so `{ where: { a, b } }` and
 * `{ where: { b, a } }` are one cache entry rather than two, and `undefined`
 * values are dropped because Prisma treats them as absent.
 *
 * The result is used directly as the cache key rather than being hashed: a
 * canonical string is a perfect hash, and a collision would mean running the
 * wrong SQL — not worth trading for shorter keys.
 */
/**
 * Argument keys whose *values* are structural rather than parameters — they end
 * up in the SQL text, so two calls that differ only there are two different
 * queries and must be two different plans.
 *
 * Getting this wrong is silent: `orderBy: { id: "asc" }` and
 * `orderBy: { id: "desc" }` have identical *types*, so without this they would
 * share a cache entry and the second caller would get the first one's SQL. The
 * plan-cache discrimination tests exist to catch exactly that.
 */
const LITERAL_KEYS = new Set([
  "orderBy",
  "select",
  // `omit` is `select`'s complement and decides the same thing — which columns
  // the statement asks for — so it fails the same way and in the worse
  // direction. `omit: { password: true }` and `{ password: false }` both shape
  // to `boolean`, so whichever compiled first decided for the other: an admin
  // screen that keeps the column warms the cache, and the public endpoint that
  // asked to hide it gets the column back. The reverse order is harmless, which
  // is exactly the wrong asymmetry.
  "omit",
  "include",
  "distinct",
  "mode",
  // An aggregate's functions decide the *projection*, so they are structural
  // for exactly the reason `select` is — and they fail the same way. Without
  // them, `_count: { email: true }` and `_count: { email: false }` both shape to
  // `{_count:{email:boolean}}`, share one entry, and the second caller gets the
  // first one's statement: a column they switched off, counted anyway. `_count:
  // true` against `_count: false` is the same collision one level up.
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
  // `skipDuplicates: true` emits `on conflict do nothing` and `false` does not,
  // so the *value* is in the SQL text. Without it here both shape to `boolean`,
  // share one entry, and whichever call compiled first decides whether the
  // other one skips conflicts — an insert that raises where the caller asked it
  // not to, or worse, one that silently swallows a duplicate the caller wanted
  // to hear about.
  "skipDuplicates",
  // `groupBy`'s grouped columns, which reach the SQL as *identifiers* — both
  // the select list and the `group by`. `["role"]` and `["locale"]` have the
  // same shape, `[string]`, so without this they would be one cache entry and
  // the second caller would be grouped by the first caller's column. Silently:
  // the result is well-formed, just grouped by something else.
  "by",
]);

/**
 * The aggregate kinds, which mean **two different things by position**.
 *
 * As a *projection* — `_count: { email: true }` — their contents decide the
 * select list, so they are in {@link LITERAL_KEYS} and recorded verbatim.
 * Inside a `having` the same keys introduce a *comparison*, and its operand is
 * a bound parameter like any other.
 *
 * Nothing else in the walk is ambiguous this way, which is why this is a set
 * rather than a general rule: the position is what disambiguates, and only
 * these five keys have two positions.
 */
const AGGREGATE_KINDS = new Set(["_count", "_avg", "_sum", "_min", "_max"]);

export function canonicalShape(
  value: unknown,
  literal = false,
  /**
   * Set when the dialect binds an `in` list as a single parameter, so that the
   * list's *length* stops being part of the key. See `collapsedList`.
   */
  collapseLists = false,
  /**
   * Set inside a `having`, where an aggregate kind is an operator rather than a
   * projection selector.
   *
   * A separate flag rather than clearing `literal`, because clearing it would
   * be wrong: `mode` lives inside `where` — already a value subtree — and
   * *must* stay literal, since `insensitive` and `default` compile to `ilike`
   * and `like`. So "nothing below a value key is structural" is not the rule;
   * "an aggregate kind below a `having` is not" is.
   */
  inHaving = false,
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const type = typeof value;
  // In a structural subtree the value itself is part of the query, so it is
  // recorded verbatim: "asc" and "desc" have to be two keys, and so do the
  // `true` and `false` of a `select`.
  if (type !== "object") return literal ? JSON.stringify(value) : type;

  if (value instanceof Date) return "date";

  /**
   * Prisma's Json null sentinels, each its own key.
   *
   * They carry no enumerable properties, so the object branch below recorded
   * all three — and a genuine empty Json object — as `{}`. They do not compile
   * alike: `DbNull` is `is null`, `JsonNull` and `{}` are `= ?` with different
   * bound values, and `AnyNull` is `is null or = ?`. So the first shape
   * compiled won the entry and every later one was answered with its text —
   * `JsonNull` served `is null` returns the SQL-NULL rows, and `DbNull` served
   * `= ?` binds NULL and matches nothing. Both silent, both wrong, and both
   * only reachable once two of them meet in one process (#266).
   *
   * This is invariant 2 read backwards. `binding.invariants.test.ts` asserts
   * that one shape with different values gives byte-identical SQL; the same
   * rule requires that different SQL means different shape, which is the half
   * nothing was checking.
   *
   * Imported rather than duplicated. `plan.ts` spells `$compositeIn` literally
   * to avoid depending on the compiler — `json-null.ts` is not the compiler but
   * a leaf module with no imports of its own, so this respects that rule
   * instead of making an exception to it.
   */
  const sentinel = jsonNullKind(value);
  if (sentinel) return `jsonNull:${sentinel}`;

  if (Array.isArray(value)) {
    // Element-wise by default, so the length is part of the shape. Usually that
    // is not a choice: `AND: [a, b]` and `AND: [a]` are different predicates,
    // `orderBy: [a, b]` is a different sort, and on SQLite `in: [a, b]`
    // compiles to `in (?, ?)` — collapsing any of them would hand a plan the
    // wrong SQL or the wrong number of placeholders.
    //
    // The exception is the `in` / `notIn` operand on a dialect that binds it as
    // one parameter, which `shapeOfMember` takes before this is reached.
    return `[${value
      .map((item) => canonicalShape(item, literal, collapseLists, inHaving))
      .join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, v]) =>
        `${key}:${shapeOfMember(key, v, literal, collapseLists, inHaving)}`,
    );
  return `{${entries.join(",")}}`;
}

/**
 * The operators whose operand is a list of values rather than a structure.
 *
 * `in` / `notIn` bind as one `= any($1)` on Postgres. So do a scalar list's
 * `hasEvery`, `hasSome` and `push` (#300) — `col @> $1`, `col && $1` and
 * `array_cat(col, $1)` are each one parameter however long the operand is, so
 * recording it element-wise mints one entry per distinct length, every one of
 * them holding SQL identical to its neighbours'. A `hasEvery` built from user
 * input is exactly the churn `collapsedList` exists to prevent.
 *
 * **Three names, and the two obvious omissions are deliberate.**
 *
 * `equals` and `set` are *overloaded*, and `set` is the one that would have
 * been a real bug rather than a missed optimisation: it is also a **relation**
 * operator — `data: { tags: { set: [{ id: 1 }, { id: 2 }] } }` rewrites a join
 * table, and that statement's text grows with the list. Collapsing it would
 * hand a plan the wrong number of placeholders, which is precisely the failure
 * the note above warns about for `OR`. Checked in `compile/nested-writes.ts`
 * rather than assumed from the name.
 *
 * The three below carry no such second meaning: `grep` finds them only in the
 * scalar-list filter set and the list write operators.
 *
 * **One case is still uncollapsed and needs a schema to fix.** A bare array as
 * a *write* value — `data: { tags: ["a", "b"] }` — is keyed by the **field
 * name**, so no fixed set can recognise it; telling it from `data: { AND: … }`
 * needs to know that `tags` is a list on this model, and `canonicalShape` is
 * deliberately schema-free. Left as churn rather than guessed at: the cost is
 * bounded by the LRU and the SQL is identical either way, where a wrong
 * collapse is a wrong statement. The filter side — which is where a
 * user-sized list actually arrives — is covered.
 */
const LIST_KEYS = new Set(["in", "notIn", "hasEvery", "hasSome", "push"]);

/**
 * The internal composite-`in` key — see `compile/where.ts`, which owns it.
 *
 * Spelled here rather than imported to keep `plan.ts` free of a dependency on
 * the compiler, the way it already is for every other key it recognises.
 */
const COMPOSITE_IN = "$compositeIn";

/**
 * `in: [1, 2]` and `in: [1, 2, 3]` on Postgres are the same SQL text — the
 * whole array binds to `= any($1)` — so they must be the same cache entry.
 *
 * Recording them element-wise there is not *wrong*, but it mints one entry per
 * distinct list length, each holding SQL identical to its neighbours'. From
 * iteration 3 on that stops being a curiosity: every batched relation query is
 * an `in` over the parent keys, so the list length is the number of rows the
 * parent query returned, and a variably-sized parent set would churn the LRU on
 * every dialect rather than on the one that needs it.
 *
 * An empty list keeps its own key: `in: []` compiles to a constant-false
 * predicate rather than to `= any($1)`, which is a different text.
 *
 * **It covers `in` / `notIn` and nothing else, which leaves one gap worth
 * naming here rather than only where it happens.** A relation joining on more
 * than one field cannot be filtered with a single `in`, so the batched loader
 * builds an `OR` of `AND`s instead (see `childQuery`) — and an `OR`'s text
 * genuinely varies with its branch count, so it cannot be collapsed the way a
 * Postgres `= any($1)` can: a shared key would hand a plan the wrong number of
 * placeholders, which is the trap described above for SQLite. Measured over
 * parent counts 2, 3, 10, 50:
 *
 *     sqlite    composite: 4 keys    single: 4 keys
 *     postgres  composite: 4 keys    single: 1 key
 *
 * That gap is closed on Postgres by #97: a composite key binds one array per
 * *column* through `unnest`, so its text is fixed too, and `shapeOfMember`
 * collapses its tuple list on the same condition this function uses. SQLite has
 * no such form, keeps the `OR`, and churns as it always has — which is the same
 * sentence as above, and for the same reason.
 */
function collapsedList(value: unknown[]): string {
  return value.length === 0 ? "[]" : "[*]";
}

/**
 * Keys that end the structural subtree. `select` and `include` are structural,
 * but a `where` nested inside one is filter *values* again — and recording
 * those verbatim would put user data into a long-lived global map and give
 * every distinct filter value its own cache entry.
 *
 * Live as of iteration 3: `include: { accounts: { where: { deletedAt: null } } }`
 * is one plan whatever the filter's values are, and the relation loader reads
 * those values back out of the *call's* argument tree rather than the compiled
 * plan's.
 */
const VALUE_KEYS = new Set(["where", "cursor", "data"]);

function shapeOfMember(
  key: string,
  value: unknown,
  literal: boolean,
  collapseLists: boolean,
  inHaving: boolean,
): string {
  // `take` is a parameter, but its *sign* is not: a negative take means "the
  // last N", which flips every ordering term and so changes the SQL text. The
  // magnitude stays out of the key, so `take: 10` and `take: 20` still share a
  // plan the way every other value does.
  if (key === "take" && typeof value === "number") {
    return `number:${Math.sign(value)}`;
  }
  // `skip` is a parameter with no structural half at all, and it needs saying
  // because a *relation node's* `skip` sits inside `include` — a literal
  // subtree, where a bare number would otherwise be recorded verbatim and mint
  // one plan entry per page. The root's `skip` never had the problem, which is
  // exactly why it went unnoticed until a node could carry one.
  if (key === "skip" && typeof value === "number") return "number";
  if (collapseLists && LIST_KEYS.has(key) && Array.isArray(value)) {
    return collapsedList(value);
  }
  /**
   * A composite `in`'s tuple list collapses on exactly the dialects where its
   * SQL text does not grow with it — the same condition, and the same reason,
   * as `collapsedList` for a single-column `in`.
   *
   * On Postgres the tuples become one array parameter per *column*, so every
   * parent count is one statement and must be one entry: without this a batched
   * composite `include` mints a plan per page size, which is #97 and the whole
   * point of the `unnest` form. On SQLite the key is never emitted — the loader
   * keeps the `OR`, whose text does grow — so the collapse cannot be reached
   * there to be wrong.
   *
   * The `fields` stay verbatim: they are *identifiers* in the emitted SQL, so
   * two relations joining on different columns must not share an entry. Only
   * the tuple list is collapsed.
   */
  if (key === COMPOSITE_IN) {
    const operand = value as { fields: unknown; values: unknown[] };
    return canonicalShape(
      collapseLists
        ? { fields: operand.fields, values: collapsedList(operand.values) }
        : value,
      true,
      collapseLists,
    );
  }

  if (VALUE_KEYS.has(key)) {
    return canonicalShape(value, false, collapseLists, inHaving);
  }

  /**
   * `having` is a predicate, so its operands are parameters — and unlike every
   * other value key it contains keys that {@link LITERAL_KEYS} would otherwise
   * re-raise one level down.
   *
   * Without this, `having: { role: { _count: { gt: 5 } } }` records `gt:5`
   * verbatim and mints one cache entry per threshold, each holding
   * byte-identical SQL. The cap is 1000 and a threshold off a query string is
   * ordinary, so it fills the cache and evicts every other query's plan — the
   * same pathology `plan.ts` already describes for `in`-list lengths, and the
   * thing `VALUE_KEYS`' own comment warns about: it would put user data into a
   * long-lived global map.
   *
   * The equivalent `where` — `{ role: { gt: 5 } }` — has always been one entry,
   * which is the behaviour this matches.
   */
  if (key === "having") return canonicalShape(value, false, collapseLists, true);

  // In a `having`, an aggregate kind is a comparison rather than a projection,
  // so it does not raise `literal` for its subtree.
  if (inHaving && AGGREGATE_KINDS.has(key)) {
    return canonicalShape(value, false, collapseLists, true);
  }

  return canonicalShape(
    value,
    literal || LITERAL_KEYS.has(key),
    collapseLists,
    inHaving,
  );
}

/**
 * Takes the dialect itself rather than its name: whether an `in` list's length
 * belongs in the key is a property of how that dialect *binds* the list, and
 * asking the dialect keeps `if (dialect === "postgres")` out of here the same
 * way the compiler keeps it out of itself.
 */
export function planKey(
  dialect: SqlDialect,
  model: string,
  op: Operation,
  args: unknown,
  /**
   * The relation strategy's name, because **different strategies emit different
   * SQL for the same arguments**.
   *
   * Leaving it out would let a query run under one strategy return a plan
   * compiled for the other — a lateral statement executed where the caller asked
   * for batched, or worse a batched one whose children are then never loaded
   * because `attachRelations` skips a plan carrying `root`. Silent wrong results
   * from a caching bug, which is the same failure shape iteration 6's policy
   * ordering had to avoid.
   *
   * Defaulted so every existing caller keys exactly as it did, which is what
   * keeps this from invalidating a warm cache.
   */
  strategy: string = "batched",
): string {
  return `${dialect.name}:${strategy}:${model}:${op}:${canonicalShape(
    args,
    false,
    dialect.bindsListAsOneParameter,
  )}`;
}

export function getOrCompile(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
  strategy?: RelationStrategy,
): QueryPlan {
  const key = planKey(dialect, schema.name, op, args, strategy?.name);
  const cached = cache.get(key);
  if (cached) {
    hits++;
    // Re-insert to move this key to the end of `Map`'s insertion order, so the
    // oldest *unused* entry is the one eviction takes.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const plan = compile(schema, op, args, dialect, strategy);
  compiles++;

  if (cache.size >= MAX_CACHED_PLANS) {
    const coldest = cache.keys().next();
    if (!coldest.done) {
      cache.delete(coldest.value);
      evictions++;
    }
  }

  cache.set(key, plan);
  return plan;
}

/**
 * Public on purpose, not only as a test seam. `compiles` climbing in step with
 * `hits` means some query shape is not being reused — a metric worth graphing,
 * and the cheapest signal that a caller is accidentally varying its argument
 * shape per request. A non-zero `evictions` means the same thing more loudly:
 * the shape space has outgrown the cap, which for a normal application should
 * not happen.
 */
export function planCacheStats(): {
  size: number;
  compiles: number;
  hits: number;
  evictions: number;
  capacity: number;
} {
  return {
    size: cache.size,
    compiles,
    hits,
    evictions,
    capacity: MAX_CACHED_PLANS,
  };
}

/**
 * Drops every compiled plan. Needed by tests that assert compile counts, and by
 * anything that reloads the generated schema in a running process.
 */
export function clearPlanCache(): void {
  cache.clear();
  compiles = 0;
  hits = 0;
  evictions = 0;
}
