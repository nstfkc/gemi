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

  // ---------------------------------------------------------------------
  // JSON path filters (#299), and the reason they arrived late (#301).
  //
  // They need a `Json` column, and the schema both invariant suites compile
  // against did not have one — a `path` on a String column is refused outright,
  // and a refused entry covers nothing. `userWithProfile` grew `metadata` for
  // this; see the note there for why that cost nothing.
  //
  // **Every entry below is refused on exactly one dialect, by name, and that is
  // the point rather than a nuisance.** `path` is the only argument in this
  // corpus whose *grammar* is dialect-specific: Postgres takes
  // `path: ["a", "b"]` and refuses a string, SQLite takes `path: "$.a.b"` and
  // refuses an array. That is Prisma's own split, measured against a generated
  // client on both, so writing one spelling would leave the other dialect's
  // half of the feature unwalked. `plan-key.invariants.test.ts` lists both
  // messages in `EXPECTED_REFUSALS` and asserts each still fires, so a dialect
  // that quietly started accepting the other form fails there.

  // The Postgres grammar. The first four are the shape #301 opened to measure:
  // three depths and a numeric segment, all compiling to the *same* statement —
  // `("metadata" #>> $1) = $2` — because `#>` takes the whole path as one
  // `text[]` parameter. Recording them element-wise minted four cache entries
  // holding one statement, keyed by a depth that is as request-derived as an
  // `in` list's length; `path` is in `LIST_KEYS` now, and this is what measures
  // it.
  { where: { metadata: { path: ["a"], equals: "x" } } },
  { where: { metadata: { path: ["a", "b"], equals: "x" } } },
  { where: { metadata: { path: ["a", "b", "c"], equals: "x" } } },
  { where: { metadata: { path: ["a", 0], equals: "x" } } },
  { where: { metadata: { path: ["a"], not: "x" } } },
  { where: { metadata: { path: ["a"], string_contains: "x" } } },
  { where: { metadata: { path: ["a"], string_starts_with: "x" } } },
  { where: { metadata: { path: ["a"], string_ends_with: "x" } } },
  // The four Postgres-only filters, which SQLite's `jsonFilters` withholds
  // because Prisma refuses them there with "Unknown argument".
  { where: { metadata: { path: ["a"], array_contains: "x" } } },
  { where: { metadata: { path: ["a"], gt: 1 } } },
  { where: { metadata: { path: ["a"], gte: 1 } } },
  { where: { metadata: { path: ["a"], lt: 1 } } },
  { where: { metadata: { path: ["a"], lte: 1 } } },
  // Two filters on one path — the `and`-grouped branch, and the only shape that
  // extracts the same path twice in one statement.
  { where: { metadata: { path: ["a"], gt: 1, lt: 9 } } },

  // The SQLite grammar, same filters minus the ones the dialect declines.
  { where: { metadata: { path: "$.a", equals: "x" } } },
  { where: { metadata: { path: "$.a.b", equals: "x" } } },
  { where: { metadata: { path: "$.a", not: "x" } } },
  { where: { metadata: { path: "$.a", string_contains: "x" } } },
  { where: { metadata: { path: "$.a", string_starts_with: "x" } } },
  { where: { metadata: { path: "$.a", string_ends_with: "x" } } },
  { where: { metadata: { path: "$.a", equals: "x", not: "y" } } },
  // Refused on SQLite for the *filter* rather than for the grammar, which is a
  // different message and the one that would fall silent if `jsonFilters` were
  // ever widened there to match Postgres.
  { where: { metadata: { path: "$.a", gt: 1 } } },
  { where: { metadata: { path: "$.a", array_contains: "x" } } },

  // The refusals #299 owns, each written in **both** grammars so the message
  // fires on the dialect that would otherwise reject the spelling first — the
  // grammar check runs before all of them.
  { where: { metadata: { path: ["a"] } } },
  { where: { metadata: { path: "$.a" } } },
  { where: { metadata: { path: ["a"], nonsense: "x" } } },
  { where: { metadata: { path: "$.a", nonsense: "x" } } },
  { where: { metadata: { path: [] } } },
  { where: { metadata: { path: "" } } },
  { where: { name: { path: ["a"], equals: "x" } } },
  { where: { name: { path: "$.a", equals: "x" } } },
  // Neither grammar, which is its own branch of the shape check.
  { where: { metadata: { path: 5, equals: "x" } } },
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
  // A to-one whose foreign key is on the **child** — `User.profile`, which is
  // why both invariant suites compile against `userWithProfile`. Its operands
  // are a different grammar from the to-many ones above rather than a subset,
  // so each spelling is its own entry: the plan-key suite is what would catch
  // one of them minting an entry per bound value, and the binding suite is what
  // would catch a filter value reaching the SQL text through the new
  // normaliser.
  //
  // What neither suite can catch is two of these *collapsing into one entry*.
  // The plan-key invariant is "same key implies same SQL", and these operands
  // all compile the parent statement identically — the difference is in the
  // `after` step, which is not SQL text. `plan.writes.discrimination.test.ts`
  // is the only thing standing under that, which is worth knowing before
  // trusting this list to protect the boolean pair below.
  ["update", { where: { id: 1 }, data: { profile: { update: { bio: "x" } } } }],
  ["update", { where: { id: 1 }, data: { profile: { update: { data: { bio: "x" } } } } }],
  ["update", { where: { id: 1 }, data: { profile: { update: { where: { bio: "old" }, data: { bio: "x" } } } } }],
  // The two booleans, which are one *shape* to everything except the guard
  // `shapeOfMember` carries for them — and they are opposite writes. `vary`
  // perturbs numbers and strings only, so it leaves them alone and the pair
  // stays meaningful here.
  ["update", { where: { id: 1 }, data: { profile: { delete: true } } }],
  ["update", { where: { id: 1 }, data: { profile: { delete: false } } }],
  ["update", { where: { id: 1 }, data: { profile: { delete: { bio: "old" } } } }],
  ["update", { where: { id: 1 }, data: { profile: { upsert: { create: { bio: "x" }, update: { bio: "y" } } } } }],
  ["update", { where: { id: 1 }, data: { profile: { upsert: { where: { bio: "old" }, create: { bio: "x" }, update: { bio: "y" } } } } }],
  ["update", { where: { id: 1 }, data: { profile: { create: { bio: "x" } } } }],
  ["update", { where: { id: 1 }, data: { profile: { connect: { userId: 1 } } } }],
  ["updateMany", { where: { id: 1 }, data: { name: "x" } }],
  ["updateMany", { data: { name: "x" } }],
  // A JSON path filter in a *write's* `where`, both grammars. The predicate
  // compiler is shared, but its entry point is not — `compileWrite` builds its
  // own `WhereContext` — and a `path` binder that located against the read's
  // argument tree would only show up from here.
  ["updateMany", { where: { metadata: { path: ["a"], equals: "x" } }, data: { name: "x" } }],
  ["updateMany", { where: { metadata: { path: "$.a", equals: "x" } }, data: { name: "x" } }],
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
  // The top-N-by-count query, which `GroupByOrderByInput` made writable (#340)
  // and which had no entry here while it was a compile error. The two forms are
  // different statements — `count(*)` counts the group, `count("name")` counts
  // its non-null rows — so both are here, and the plan-key suite is what would
  // catch them collapsing into one.
  { by: ["name"], _count: true, orderBy: { _count: { _all: "desc" } } },
  { by: ["name"], _count: true, orderBy: { _count: { name: "desc" } } },
  { by: ["name"], _count: true, orderBy: { _count: { _all: { sort: "desc", nulls: "last" } } } },
  // An aggregate `having` on an ungrouped column, which Prisma's `or` allows and
  // which `GroupByHavingInput` stopped refusing in the same PR.
  { by: ["globalRole"], _count: true, having: { locale: { _count: { gt: 1 } } } },
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

