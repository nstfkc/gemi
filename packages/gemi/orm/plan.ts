import { compile } from "./compile";
import type { BindContext } from "./compile/fragment";
import type { NestedWriteStep, RelationPlan } from "./compile/plan-relations";
import type { SqlDialect } from "./dialect";
import type { ModelSchema } from "./schema";

/**
 * The public operations. `aggregate`, `groupBy` and the raw operations are
 * deliberately not among them: they are excluded at the operation level rather
 * than narrowed out of the argument types, because narrowing Prisma's recursive
 * where-inputs with `Omit` is miserable.
 */
export type Operation =
  | "findUnique"
  | "findUniqueOrThrow"
  | "findFirst"
  | "findFirstOrThrow"
  | "findMany"
  | "count"
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "upsert"
  | "delete"
  | "deleteMany";

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
  "include",
  "distinct",
  "mode",
]);

export function canonicalShape(
  value: unknown,
  literal = false,
  /**
   * Set when the dialect binds an `in` list as a single parameter, so that the
   * list's *length* stops being part of the key. See `collapsedList`.
   */
  collapseLists = false,
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const type = typeof value;
  // In a structural subtree the value itself is part of the query, so it is
  // recorded verbatim: "asc" and "desc" have to be two keys, and so do the
  // `true` and `false` of a `select`.
  if (type !== "object") return literal ? JSON.stringify(value) : type;

  if (value instanceof Date) return "date";
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
      .map((item) => canonicalShape(item, literal, collapseLists))
      .join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${key}:${shapeOfMember(key, v, literal, collapseLists)}`);
  return `{${entries.join(",")}}`;
}

/** The operators whose operand is a list of values rather than a structure. */
const LIST_KEYS = new Set(["in", "notIn"]);

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
): string {
  // `take` is a parameter, but its *sign* is not: a negative take means "the
  // last N", which flips every ordering term and so changes the SQL text. The
  // magnitude stays out of the key, so `take: 10` and `take: 20` still share a
  // plan the way every other value does.
  if (key === "take" && typeof value === "number") {
    return `number:${Math.sign(value)}`;
  }
  if (collapseLists && LIST_KEYS.has(key) && Array.isArray(value)) {
    return collapsedList(value);
  }
  if (VALUE_KEYS.has(key)) return canonicalShape(value, false, collapseLists);
  return canonicalShape(
    value,
    literal || LITERAL_KEYS.has(key),
    collapseLists,
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
): string {
  return `${dialect.name}:${model}:${op}:${canonicalShape(
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
): QueryPlan {
  const key = planKey(dialect, schema.name, op, args);
  const cached = cache.get(key);
  if (cached) {
    hits++;
    // Re-insert to move this key to the end of `Map`'s insertion order, so the
    // oldest *unused* entry is the one eviction takes.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const plan = compile(schema, op, args, dialect);
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
