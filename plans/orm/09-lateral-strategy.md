# Iteration 9 — The lateral relation strategy

**Goal.** A `LATERAL` + `json_agg` relation strategy on Postgres: one round trip
for an entire include tree instead of one per node.

This is iteration 7's deliverable 2, promoted to its own iteration for two
reasons. It was **declined and then re-justified** on corrected measurements, so
the decision needs its own record. And building it requires **widening the
strategy seam**, which iteration 7 explicitly says would be a finding rather than
a workaround — so it is not a change to append to the PR that justified it.

Read [README.md](./README.md) first, especially invariant 4, and
[07-performance.md](./07-performance.md) §2.

## Prerequisite state

Iterations 1–8 are implemented. The batched strategy ships and is the only one.
`plans/orm/benchmarks.md` is committed and is the justification below.

## Why this is worth building — and why the first answer was no

Iteration 7 concluded **do not build it**. That conclusion came from scenario 4
appearing to show the batched planner not falling behind at depth 3, and it was
wrong twice over:

1. Scenario 4's baseline ran on a different connection from every other
   scenario's.
2. More seriously, **it was not measuring a depth-3 include at all.** The seed
   created accounts with no `organizationId`, so every third-level foreign key was
   null, the batched loader correctly skipped that query, and the scenario
   measured depth-2 plus a filter pass. It read as *faster* than depth-2 — more
   nodes, less time — which was the tell.

With the seed fixed the conclusion reversed. A second version then argued the size
of the win from the wall-clock gap between depths, and **that gap is not
reproducible**: across two runs of identical code it moved from +397µs to +17µs, a
23× swing on the deciding quantity.

So the case rests on neither. Round trips are **counted** — one query per include
node, a property the batched planner guarantees:

```
no include        1 statement
depth-2 include   2 statements
depth-3 include   3 statements
```

The cost of one round trip is measured directly by the point-read scenario, which
is the most stable number in the suite. A lateral join collapses N statements into
1, so the removable cost is `(N - 1) × one round trip`. Every input is either a
count that cannot drift or the suite's steadiest timing.

**On SQLite it stays unjustified.** The counts are identical, but the round trips
are in-process and cost tens of microseconds rather than hundreds. `json_group_array`
should be built only if a SQLite-specific measurement asks for it — and none does.

## The finding: the seam does not accommodate this

Iteration 3 built the relation planner as a swappable stage and iteration 7 says
the lateral form "has to be a sibling `RelationStrategy`". It cannot be, as the
interface stands. This is the restructuring iteration 7's notes ask to be reported
rather than worked around.

```ts
interface RelationStrategy {
  readonly name: string
  plan(request: RelationRequest): RelationPlan
}

interface RelationPlan {
  as: string
  kind: "one" | "many"
  parentField: string
  strategy: string
  load(parents, args, executor): Promise<void>   // ← runs AFTER the root query
}

interface RelationPlanning {
  plans: RelationPlan[]
  keyFields: string[]        // ← the only thing a strategy can add to the root
}
```

A strategy's entire output is a `load()` that runs once the root rows exist, plus
a list of *field names* the root must select so stitching has keys. `compileRead`
builds the root statement from `fields` alone:

```ts
const { plans, keyFields } = planRelations(schema, args, dialect, op)
const { fields, hidden } = withKeyFields(schema, selection, keyFields)
const columns = joinFragments(fields.map((f) => sql(dialect.quoteIdent(f.column))), ", ")
```

There is no way for a strategy to contribute a **column expression**, a **join
clause**, or a **table alias** — which is all three of the things a lateral join
needs. The seam is genuinely swappable for *"fetch children separately, by some
means"* and closed to *"fold children into the root statement"*.

That is a narrower abstraction than invariant 4 claims, and the claim should be
corrected in the README either way. It is not a wasted design: the batching
strategy and any future *n*+1-avoiding variant fit it, and it kept the compiler
free of relation knowledge. But it does not span the space it says it does.

### What the widening should be

Minimal, and additive so the batched strategy keeps compiling unchanged:

```ts
interface RelationPlan {
  // …existing members
  /**
   * SQL this relation contributes to the *root* statement, for a strategy that
   * folds children in rather than fetching them separately. Absent for the
   * batched strategy, whose `load` runs afterwards.
   */
  root?: {
    /** Appended to the root select list, aliased to `as`. */
    column: Fragment
    /** Appended after the `from` clause. */
    join: Fragment
    /** Turns the column's value into the shaped relation. */
    decode(value: unknown): unknown
  }
}
```

Consequences to work through, none of which is optional:

- **The root table needs an alias**, because a lateral subquery introduces a
  second scope and unqualified column names become ambiguous. Every root column
  reference has to be qualified, which touches `compileRead`, `compileWrite`'s
  `returning`, and `compileWhere`. That is the largest part of the work and the
  reason this is its own iteration.
- **`plan.shape` has to run the `decode`** for a `root` relation instead of
  writing the empty placeholder that the shaper writes today.
- **`attachRelations` must skip** a plan carrying `root`, since its children are
  already present.
- **Strategy selection becomes real** — iteration 7 deliverable 3 shipped
  observability against one strategy; with two there must be a rule, and it must
  be overridable per query.

## Deliverables

1. The seam widening above, with the batched strategy unchanged and proven so by
   the existing tests.
2. Root-table aliasing across read, write-returning and where compilation.
3. The lateral strategy for Postgres, behind the seam.
4. **JSON type flattening.** `json_agg` returns text: dates become strings,
   numerics may become strings, `Bytes` needs care. The decoder must be aware of
   dialect *and* strategy. This is the largest correctness risk in the iteration.
5. `coalesce` so an empty to-many shapes to `[]` rather than `null` —
   `json_agg` over zero rows returns `NULL`.
6. Strategy selection, overridable per query, observable through the existing
   `QueryPlan.strategies`.
7. The **full** nested differential matrix run against both strategies, not a
   subset. Two implementations means two places for shape divergence.

## Acceptance criteria

1. The batched strategy is unchanged and every existing test passes untouched.
2. The lateral strategy passes the full nested differential matrix on Postgres,
   including type decoding and empty-to-many shaping.
3. A policy-scoped nested read is correctly scoped **under the lateral strategy** —
   the load-bearing claim of invariant 4, since policies rewrite args before
   planning and the scope must land inside the lateral subquery.
4. Statement count for a depth-3 include is **1** under lateral and 3 under
   batched, asserted by the counter rather than inferred.
5. Strategy selection is observable and overridable, with tests for both.
6. The benchmark shows the predicted saving, or reports that it does not.
7. `bun run lint` and `bun run test` pass; the differential harness is green on
   both strategies.

## Out of scope

SQLite's `json_group_array` — no measurement asks for it. MySQL. Choosing lateral
by *estimated row count* rather than by tree depth; that wants statistics the ORM
does not have.

## Notes and risks

- **This is the first iteration that changes emitted SQL for existing queries**,
  via root-table aliasing. Byte-identical SQL for identical shapes is invariant 2,
  and aliasing changes the bytes for every read. The differential harness compares
  *results*, not text, so it will not catch a mistake here — the plan-cache
  discrimination tests and the compiler's own text assertions are what must be
  updated deliberately rather than adjusted until green.
- **Two strategies double the surface for shape divergence**, which iteration 7's
  notes already flag. CI must exercise both, not only the default.
- **The win is predicted, not measured.** `(N-1) × one round trip` is an upper
  bound: it ignores `json_agg`'s server-side cost and the wider result to parse.
  If the measured saving comes in far below the prediction, that is the finding,
  and deliverable 6 says to report it rather than bury it.
