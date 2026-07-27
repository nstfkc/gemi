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

/** Test seam: proves a repeated query shape compiles exactly once. */
export function planCacheStats(): {
  size: number;
  compiles: number;
  hits: number;
} {
  return { size: cache.size, compiles, hits };
}

export function clearPlanCache(): void {
  cache.clear();
  compiles = 0;
  hits = 0;
}
