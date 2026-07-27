import type { Dialect } from "../database/dialect";
import { compile } from "./compile";
import type { SqlDialect } from "./dialect";
import type { ModelSchema } from "./schema";

/**
 * The twelve public operations. `aggregate`, `groupBy` and the raw operations
 * are deliberately not among them: they are excluded at the operation level
 * rather than narrowed out of the argument types, because narrowing Prisma's
 * recursive where-inputs with `Omit` is miserable.
 */
export type Operation =
  | "findUnique"
  | "findUniqueOrThrow"
  | "findFirst"
  | "findFirstOrThrow"
  | "findMany"
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

const cache = new Map<string, QueryPlan>();
let compiles = 0;
let hits = 0;

/**
 * A canonical description of an argument tree's *shape* — key paths, operators
 * and value kinds, never values. Keys are sorted so `{ where: { a, b } }` and
 * `{ where: { b, a } }` are one cache entry rather than two, and `undefined`
 * values are dropped because Prisma treats them as absent.
 *
 * The result is used directly as the cache key rather than being hashed: a
 * canonical string is a perfect hash, and query shapes are finite per
 * application so the memory is not worth a collision risk.
 */
export function canonicalShape(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const type = typeof value;
  if (type !== "object") return type;

  if (value instanceof Date) return "date";
  if (Array.isArray(value)) {
    // Element-wise, so the length is part of the shape. That is not a choice:
    // `in: [a, b]` compiles to `in (?, ?)` and `in: [a, b, c]` to `in (?, ?, ?)`,
    // so collapsing them to one key would hand a plan the wrong number of
    // placeholders. Length has to stay visible.
    //
    // WARNING for iteration 2: nothing reaches the cache with an array today
    // (unknown operators throw before `cache.set`), so the key space is bounded
    // by field subsets. The moment `in` lands, every distinct filter-list length
    // a request supplies becomes a permanent entry in a module-global Map keyed
    // off user input. The cache needs a bound — an eviction policy, not a
    // coarser key — before that ships.
    return `[${value.map(canonicalShape).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${key}:${canonicalShape(v)}`);
  return `{${entries.join(",")}}`;
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
    return cached;
  }

  const plan = compile(schema, op, args, dialect);
  compiles++;
  cache.set(key, plan);
  return plan;
}

/**
 * Public on purpose, not only as a test seam. `compiles` climbing in step with
 * `hits` means some query shape is not being reused — a metric worth graphing,
 * and the cheapest signal that a caller is accidentally varying its argument
 * shape per request.
 */
export function planCacheStats(): {
  size: number;
  compiles: number;
  hits: number;
} {
  return { size: cache.size, compiles, hits };
}

/**
 * Drops every compiled plan. Needed by tests that assert compile counts, and by
 * anything that reloads the generated schema in a running process.
 */
export function clearPlanCache(): void {
  cache.clear();
  compiles = 0;
  hits = 0;
}
