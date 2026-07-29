/**
 * A corpus of argument shapes, shared by the invariant suites.
 *
 * Extracted rather than duplicated because two suites now walk the same
 * shapes — `plan-key.invariants.test.ts` and `binding.invariants.test.ts` —
 * and a corpus that drifts between them is worse than one that is short.
 *
 * **This is the thing to extend when a new argument is implemented.** It is
 * deliberately broad rather than minimal: a case costs one line, and both
 * failure modes it guards are silent.
 */
export const READS: unknown[] = [
  {},
  { where: { id: 1 } },
  { where: { id: 2 } },
  { where: { name: "a" } },
  { where: { name: { contains: "a" } } },
  { where: { name: { startsWith: "a" } } },
  { where: { name: { endsWith: "a" } } },
  { where: { name: { equals: "a" } } },
  { where: { name: { not: "a" } } },
  { where: { id: { gt: 1 } } },
  { where: { id: { gte: 1 } } },
  { where: { id: { lt: 1 } } },
  { where: { id: { lte: 1 } } },
  { where: { id: { in: [1, 2] } } },
  { where: { id: { in: [1, 2, 3] } } },
  { where: { id: { notIn: [1] } } },
  // An empty list keeps its own plan key: `in: []` compiles to a constant-false
  // predicate rather than `= any($1)`, which is a different statement. Found by
  // mutation testing — `collapsedList`'s `length === 0` could be inverted with
  // nothing noticing, because the corpus had no empty list in it.
  { where: { id: { in: [] } } },
  { where: { id: { notIn: [] } } },
  { where: { name: { contains: "a", mode: "insensitive" } } },
  { where: { AND: [{ id: 1 }, { name: "a" }] } },
  { where: { OR: [{ id: 1 }, { name: "a" }] } },
  { where: { NOT: { id: 1 } } },
  { where: { accounts: { some: { id: 1 } } } },
  { where: { accounts: { every: { id: 1 } } } },
  { where: { accounts: { none: { id: 1 } } } },
  { where: { organization: { is: { id: 1 } } } },
  { where: { organization: { isNot: { id: 1 } } } },
  { select: { id: true } },
  { select: { id: true, name: true } },
  { omit: { name: true } },
  { include: { accounts: true } },
  { include: { organization: true } },
  { include: { accounts: { select: { id: true } } } },
  { include: { accounts: { where: { id: 1 } } } },
  { include: { accounts: { take: 2 } } },
  { include: { accounts: { orderBy: { id: "asc" } } } },
  { include: { accounts: { orderBy: { id: "desc" } } } },
  { include: { _count: { select: { accounts: true } } } },
  { orderBy: { id: "asc" } },
  { orderBy: { id: "desc" } },
  { orderBy: { name: { sort: "asc", nulls: "first" } } },
  { orderBy: { name: { sort: "asc", nulls: "last" } } },
  { orderBy: [{ id: "asc" }, { name: "desc" }] },
  { orderBy: { accounts: { _count: "asc" } } },
  { take: 1 },
  { take: 5 },
  { skip: 1 },
  { skip: 1, take: 2 },
];

export const WRITES: [string, unknown][] = [
  ["create", { data: { email: "a@b.c" } }],
  ["create", { data: { email: "a@b.c", name: "n" } }],
  ["create", { data: { email: "a@b.c" }, select: { id: true } }],
  [
    "create",
    { data: { email: "a@b.c", accounts: { create: { provider: "p", providerAccountId: "x" } } } },
  ],
  ["create", { data: { email: "a@b.c", organization: { connect: { id: 1 } } } }],
  ["createMany", { data: [{ email: "a@b.c" }] }],
  ["createMany", { data: [{ email: "a@b.c" }, { email: "d@e.f" }] }],
  ["update", { where: { id: 1 }, data: { name: "x" } }],
  ["update", { where: { id: 1 }, data: { globalRole: { increment: 1 } } }],
  ["update", { where: { id: 1 }, data: { globalRole: { decrement: 1 } } }],
  ["update", { where: { id: 1 }, data: { globalRole: { multiply: 2 } } }],
  ["update", { where: { id: 1 }, data: { globalRole: { divide: 2 } } }],
  ["update", { where: { id: 1 }, data: { globalRole: { set: 2 } } }],
  ["update", { where: { id: 1 }, data: { accounts: { connect: { id: 1 } } } }],
  ["update", { where: { id: 1 }, data: { accounts: { disconnect: { id: 1 } } } }],
  ["update", { where: { id: 1 }, data: { accounts: { delete: { id: 1 } } } }],
  ["update", { where: { id: 1 }, data: { accounts: { deleteMany: {} } } }],
  ["updateMany", { where: { id: 1 }, data: { name: "x" } }],
  ["updateMany", { data: { name: "x" } }],
  ["delete", { where: { id: 1 } }],
  ["delete", { where: { id: 1 }, select: { id: true } }],
  // The conflict target has to be set by `create`, or `Model.upsert` runs it as
  // a read and a write instead and there is no single statement to key.
  ["upsert", { where: { email: "a@b.c" }, create: { email: "a@b.c" }, update: { name: "x" } }],
];

export const AGGREGATES: unknown[] = [
  { _count: true },
  { _sum: { globalRole: true } },
  { _avg: { globalRole: true } },
  { _min: { globalRole: true } },
  { _max: { globalRole: true } },
  { _count: true, where: { id: 1 } },
  { _count: true, take: 2 },
  { _count: true, skip: 1 },
];

export const GROUPS: unknown[] = [
  { by: ["name"], _count: true },
  { by: ["locale"], _count: true },
  { by: ["name", "locale"], _count: true },
  // #92's shape: two thresholds that must share an entry. The grouped column
  // has to be the one filtered on — a `having` on anything else is refused,
  // and an entry that does not compile would test nothing.
  { by: ["globalRole"], _count: true, having: { globalRole: { gt: 1 } } },
  { by: ["globalRole"], _count: true, having: { globalRole: { gt: 200 } } },
  { by: ["name"], _count: true, orderBy: { name: "asc" } },
];

/**
 * The keys whose *values* decide the statement, so a value under one is
 * structural rather than bound. Kept here rather than imported so that
 * widening `LITERAL_KEYS` without thinking does not silently widen this too.
 */
const LITERAL = new Set([
  "orderBy",
  "select",
  "omit",
  "include",
  "distinct",
  "mode",
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
  "by",
  "skipDuplicates",
]);

/** Every scalar that is bound as a parameter, replaced; structure untouched. */
export function vary(node: unknown, bound = false): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((entry) => vary(entry, bound));
  if (typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = LITERAL.has(key)
        ? value
        : vary(value, bound || key === "where" || key === "data" || key === "having");
    }
    return out;
  }
  if (!bound) return node;
  if (typeof node === "number") return node + 977;
  if (typeof node === "string") return "ZZZZ";
  return node;
}

