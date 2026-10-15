import { UniqueConstraintError } from "../../../../../orm/errors";

/**
 * A table in memory behind the slice of Prisma's model API the Prisma stores
 * use: `create`, `findUnique`, `findFirst`, `findMany`, `count`,
 * `updateMany`, `deleteMany`, with Prisma's `where` (equality, `null`, `in`,
 * `notIn`, `not`, `gt`, `gte`, `lt`, `lte`, `startsWith`, `OR`), `orderBy`
 * and `select`. Each call yields to the event loop before it reads or writes,
 * and then runs to completion, as one statement does in a database, so racing
 * callers really interleave.
 *
 * `unique` picks how a duplicate primary key fails: gemi ORM's
 * `UniqueConstraintError`, or Prisma's `P2002`.
 */
export function memoryModel(
  name: string,
  options: { id: string; defaults?: () => Record<string, unknown>; unique?: "gemi" | "prisma" },
) {
  const rows = new Map<string, Record<string, any>>();
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
  const filter = (where: Record<string, any> = {}) => [...rows.values()].filter((row) => matches(row, where));
  const pick = (row: Record<string, any>, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row);

  return {
    rows,
    async create({ data }: { data: Record<string, any> }) {
      await tick();
      const key = String(data[options.id]);
      if (rows.has(key)) {
        if (options.unique === "prisma") {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        throw new UniqueConstraintError(name, "create", [options.id]);
      }
      const row = { ...options.defaults?.(), ...structuredClone(data) };
      rows.set(key, row);
      return structuredClone(row);
    },
    async findUnique({ where, select }: { where: Record<string, any>; select?: Record<string, boolean> }) {
      await tick();
      const row = filter(where)[0];
      return row ? pick(row, select) : null;
    },
    async findFirst({ where, select }: { where?: Record<string, any>; select?: Record<string, boolean> }) {
      await tick();
      const row = filter(where)[0];
      return row ? pick(row, select) : null;
    },
    async findMany(args: { where?: Record<string, any>; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> } = {}) {
      await tick();
      let found = filter(args.where);
      if (args.orderBy) {
        const [[field, direction]] = Object.entries(args.orderBy);
        found = found.sort((a, b) => (compare(a[field], b[field]) * (direction === "desc" ? -1 : 1)));
      }
      return found.map((row) => pick(row, args.select));
    },
    async count({ where }: { where?: Record<string, any> } = {}) {
      await tick();
      return filter(where).length;
    },
    async updateMany({ where, data }: { where?: Record<string, any>; data: Record<string, any> }) {
      await tick();
      const found = filter(where);
      for (const row of found) Object.assign(row, structuredClone(data));
      return { count: found.length };
    },
    async deleteMany({ where }: { where?: Record<string, any> } = {}) {
      await tick();
      const found = filter(where);
      for (const row of found) rows.delete(String(row[options.id]));
      return { count: found.length };
    },
  };
}

function value(v: unknown) {
  return v instanceof Date ? v.getTime() : v;
}

function compare(a: unknown, b: unknown) {
  const [x, y] = [value(a) as any, value(b) as any];
  return x < y ? -1 : x > y ? 1 : 0;
}

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === "OR") return (condition as Record<string, any>[]).some((each) => matches(row, each));
    const actual = row[field] ?? null;
    if (condition === null || typeof condition !== "object" || condition instanceof Date) {
      return value(actual) === value(condition);
    }
    return Object.entries(condition).every(([op, operand]: [string, any]) => {
      switch (op) {
        case "in":
          return operand.some((each: unknown) => value(each) === value(actual));
        case "notIn":
          return !operand.some((each: unknown) => value(each) === value(actual));
        case "not":
          return value(actual) !== value(operand);
        case "gt":
          return actual !== null && compare(actual, operand) > 0;
        case "gte":
          return actual !== null && compare(actual, operand) >= 0;
        case "lt":
          return actual !== null && compare(actual, operand) < 0;
        case "lte":
          return actual !== null && compare(actual, operand) <= 0;
        case "startsWith":
          return typeof actual === "string" && actual.startsWith(operand);
        default:
          throw new Error(`memoryModel: ${op} is not implemented`);
      }
    });
  });
}

/** The three OAuth tables. */
export function memoryOAuthModels(unique: "gemi" | "prisma" = "gemi") {
  return {
    clients: memoryModel("McpOAuthClient", { id: "clientId", defaults: () => ({ createdAt: new Date() }), unique }),
    credentials: memoryModel("McpOAuthCredential", {
      id: "hash",
      defaults: () => ({ createdAt: new Date(), revokedAt: null, redirectUri: null, codeChallenge: null }),
      unique,
    }),
    uses: memoryModel("McpOAuthUse", { id: "key", unique }),
  };
}
