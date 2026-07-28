# Iteration 3 — Motorcycle: relations

**Goal.** `include` and nested `select` / `include`, to arbitrary depth, via the
batched planner — with the relation planner established as a swappable stage.

This is where the ORM stops being a query builder and becomes an ORM, and it is
the iteration with the most subtle result-shape work. The differential harness
from iteration 2 is what makes it tractable.

Read [README.md](./README.md) first, especially invariant 4.

## Prerequisite state

Iterations 1–2 are merged. The full scalar read surface works on SQLite and
Postgres, and the differential harness is green.

## Read first

- `packages/gemi/orm/compile/` — the where compiler and `Fragment`.
- `packages/gemi/orm/shape.ts` — the shaper, which now has to nest.
- `packages/gemi/orm/registry.ts` — this is the iteration where it finally earns
  its existence.
- `packages/gemi/orm/schema.ts` — `RelationSchema`, emitted in iteration 1 and
  unused until now. Verify the generator is actually populating `joinTable` for
  implicit m-n; it was written speculatively.
- `templates/saas-starter/prisma/schema.prisma` — all relations are 1-1 / 1-n.
  There is **no implicit many-to-many to test against**, which is why this
  iteration needs its own fixture schema.

## Deliverables

### 1. The planner as a distinct stage

`packages/gemi/orm/compile/plan-relations.ts` (name negotiable, separation not):
takes the include tree plus the root model and emits a strategy. This iteration
implements exactly one — batched separate queries — but the shape of the code
must make iteration 7's lateral+json a sibling implementation, not a rewrite.

The strategy interface is roughly: given a parent plan and a relation node,
produce the child query and the instruction for stitching its results onto the
parent rows.

### 2. Batched relation loading

For `include: { accounts: true }` over 100 users:

1. Run the root query.
2. Collect the parent key values.
3. Run **one** child query per relation node: `where <fk> in (<parent keys>)`.
4. Stitch by key.

One query per **node in the include tree**, not per row. Depth 3 with two
branches is 5 queries, not 500. Say this in a comment; it is the thing people
assume is wrong.

Each child query goes through `Model.$exec` on the **related model's class**,
recursively (invariant 1). Not through a private helper. This is what makes
iteration 6's policies apply to nested reads, and it is the single most
valuable structural decision in this iteration.

The `in (<parent keys>)` clause has the same variable-length plan-cache problem
as iteration 2's `in` operator, at higher volume. Reuse whatever was decided
there; do not invent a second mechanism.

### 3. Nested `select` and `include`

The full Prisma matrix, which is larger than it first looks:

- `include: { user: true }`
- `include: { user: { select: { id: true } } }`
- `select: { id: true, accounts: { select: { id: true } } }`
- `include: { accounts: { where, orderBy, take, skip } }` — relation queries take
  their own filter arguments
- `select` and `include` mutually exclusive at every level, not just the root

`include: { accounts: { take: 5 } }` means five per parent, not five overall.
Under the batched strategy that is a per-parent limit inside a single query,
which needs a window function on Postgres (`row_number() over (partition by ...)`)
and is genuinely awkward on SQLite. **Decide explicitly**: either implement the
window-function form, or throw `UnsupportedQueryError` for `take`/`skip` on
to-many relations and schedule it for iteration 7 alongside lateral joins, where
it falls out naturally. Do not silently apply a global limit — that returns
wrong data.

### 4. To-one vs to-many shaping

- To-one, present: the object.
- To-one, absent: `null` — not `undefined`, not a missing key. Prisma returns
  `null` and the differential harness compares key presence.
- To-many, empty: `[]` — not `null`, not absent.

These three lines are where most of the divergence bugs will be.

### 5. Nested shaper

The shaper becomes a tree built once per plan, mirroring the include tree. Still
no per-row schema lookups and no per-row `for...in`. Stitching is by a `Map` from
parent key to parent row, built once per child query — not a nested scan.

### 6. Implicit many-to-many

Prisma's implicit m-n uses a `_RelationName` join table with `A` / `B` columns.
The generator emits `joinTable` for these; the planner needs a two-hop child
query.

The template schema cannot exercise this. Add a dedicated fixture — a small
`schema.prisma` under the ORM's test fixtures with an implicit m-n pair, plus a
throwaway SQLite database — and run the differential harness against it. Without
a fixture this feature is untested, and untested join-table logic is worse than
an honest `UnsupportedQueryError`.

If the fixture proves expensive, throwing for implicit m-n is an acceptable
outcome for this iteration. Say which was chosen in the PR.

### 7. Cycle and depth guards

`include: { user: { include: { accounts: { include: { user: ... } } } } }` is
legal and finite, but a malformed or generated arg tree can be unbounded. Add a
depth limit with a clear error. Also guard the registry against a relation naming
a model that is not registered — that means a stale generated artifact, and the
error should say so.

## Acceptance criteria

1. Differential harness green across the nested matrix on both dialects:
   to-one, to-many, empty to-many, null to-one, nested `select` inside `include`,
   relation-level `where` and `orderBy`, depth ≥ 3.
2. A test asserting **query count**: `include` over N parents with a depth-2 tree
   issues a number of queries proportional to the tree, not to N. This is the
   regression test that catches an accidental N+1 later.
3. Each relation query is observably a `Model.$exec` call on the related model
   class — assertable by spying on `$exec`. Iteration 6 depends on this.
4. `select` and `include` together at any level throws.
5. `take` / `skip` on a to-many relation either works correctly per-parent or
   throws `UnsupportedQueryError` — with a test either way, and the choice
   recorded in the PR description.
6. Implicit m-n either works against the fixture schema or throws — again with a
   test, and the choice recorded.
7. Depth-guard and unregistered-model errors are tested and legible.
8. `bun run lint` and `bun run test` pass.

## Out of scope

Lateral / `json_agg` strategies (iteration 7), ~~`_count` on relations~~,
~~relation filters in `where`~~ (`some` / `every` / `none` — they belong with the
where compiler and are worth scheduling explicitly, likely alongside iteration
4), all writes, transactions, policies.

Both of the struck items are **done**, after iteration 9 rather than alongside
iteration 4. `_count` turned out to be the same machinery as the relation
filters — a correlated subquery over the child, aliased so a self-relation
cannot shadow the outer table — projected instead of predicated, so it landed in
the same pass. Nine differential cases compare it against Prisma.

It is also a **third** instance of the rule this project keeps rediscovering:
every path that reaches another model's rows is a read of that model and carries
its policies. Nested includes were the first (iteration 6), the lateral
strategy's folded subquery the second (iteration 9), relation filters and
`_count` the third and fourth. The counts are the quietest of them — an unscoped
count returns a *number*, so what leaks is how many rows exist in tenants the
caller cannot see. Worth stating as a rule rather than as four fixes: **if a
compiled statement names another model's table, that model's policies belong in
it.**

## Notes and risks

- **This is the iteration most likely to grow a private query path** — "it's just
  one small helper for relation loading." That helper is how policies come to not
  apply to nested reads, which is the exact Prisma flaw this project exists to
  fix. Route everything through `$exec`.
- **Relation filters in `where`** (`where: { accounts: { some: { ... } } }`) are
  not relation *loading* and do not belong here — they compile to
  `EXISTS (SELECT 1 ...)` subqueries in the where compiler. They are cheap to add
  and often assumed present. Consider scheduling them as a small follow-up
  rather than letting them creep into this iteration.

  **Done, after iteration 9.** `some` / `every` / `none` and `is` / `isNot`, as
  correlated `exists` subqueries, verified against Prisma by twenty new cases in
  the differential matrix. Two things this note did not anticipate:

  - **They are a policy surface, not just a where-compiler feature.** A filter
    that reaches another model's rows is a read of that model, so the child's
    policies have to scope the subquery — the same rule iteration 9 had to make
    true for the lateral strategy, arriving from a third direction. The leak is
    quieter here: the query returns no child rows, so an unscoped subquery leaks
    *existence* rather than data.
  - **`every` cannot be scoped by ANDing.** It compiles to
    `not exists (child where correlated and not X)`, so a scope ANDed into `X`
    means "every child either matches or is invisible" — a parent whose only
    non-matching child is another tenant's would start passing. The scope has to
    restrict which children are *considered*, which in argument space is
    `every: { OR: [{ NOT: S }, X] }`.

  Still open: ordering by a relation, and filtering across an implicit
  many-to-many (two hops through the join table).
- **Stitching cost is real** on wide results. Build the parent-key `Map` once per
  child query; do not `find()` per row. Iteration 7 will measure this, so leave
  it in a shape that can be measured.
