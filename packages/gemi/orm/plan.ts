import type { Dialect } from "../database/dialect";
import { compile } from "./compile";
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
  bind(args: any): unknown[];
  shape(rows: unknown[]): unknown;
}

/**
 * The cache is bounded because one part of the key space is *not* finite per
 * application: on SQLite an `in` list expands to one placeholder per element,
 * so every distinct list length is its own plan — and list length is routinely
 * request-derived (`?ids=1,2,3` off a query string). Unbounded, that is a slow
 * memory leak reachable from untrusted input.
 *
 * A coarser key cannot fix it: collapsing lengths would hand a plan the wrong
 * number of placeholders. Eviction is the only correct answer.
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

export function canonicalShape(value: unknown, literal = false): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const type = typeof value;
  // In a structural subtree the value itself is part of the query, so it is
  // recorded verbatim: "asc" and "desc" have to be two keys, and so do the
  // `true` and `false` of a `select`.
  if (type !== "object") return literal ? JSON.stringify(value) : type;

  if (value instanceof Date) return "date";
  if (Array.isArray(value)) {
    // Element-wise, so the length is part of the shape. That is not a choice:
    // `in: [a, b]` compiles to `in (?, ?)` and `in: [a, b, c]` to `in (?, ?, ?)`,
    // so collapsing them to one key would hand a plan the wrong number of
    // placeholders. Length has to stay visible.
    //
    // This is the one part of the key space an application does not bound:
    // list length is routinely request-derived. The cache's LRU cap is what
    // contains it — see `MAX_CACHED_PLANS`. On Postgres the array binds to a
    // single parameter and every length shares one text, so only SQLite grows
    // entries this way.
    return `[${value.map((item) => canonicalShape(item, literal)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${key}:${shapeOfMember(key, v, literal)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Keys that end the structural subtree. `select` and `include` are structural,
 * but a `where` nested inside one is filter *values* again — and recording
 * those verbatim would put user data into a long-lived global map and give
 * every distinct filter value its own cache entry.
 *
 * Inert today, because `include` throws before it can reach the cache. Iteration
 * 3 turns it on, and it is much cheaper to be right about it here than to find
 * it alongside relation compilation.
 */
const VALUE_KEYS = new Set(["where", "cursor", "data"]);

function shapeOfMember(key: string, value: unknown, literal: boolean): string {
  // `take` is a parameter, but its *sign* is not: a negative take means "the
  // last N", which flips every ordering term and so changes the SQL text. The
  // magnitude stays out of the key, so `take: 10` and `take: 20` still share a
  // plan the way every other value does.
  if (key === "take" && typeof value === "number") {
    return `number:${Math.sign(value)}`;
  }
  if (VALUE_KEYS.has(key)) return canonicalShape(value, false);
  return canonicalShape(value, literal || LITERAL_KEYS.has(key));
}

export function planKey(
  dialect: Dialect,
  model: string,
  op: Operation,
  args: unknown,
): string {
  return `${dialect}:${model}:${op}:${canonicalShape(args)}`;
}

export function getOrCompile(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  const key = planKey(dialect.name, schema.name, op, args);
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
