# Iteration 7 — Performance

**Goal.** Measure first, then close the gap: a `LATERAL` + `json_agg` relation
strategy on Postgres, generated shapers, and a benchmark suite that times
compile, execute and shape separately.

Everything before this iteration was built to be fast — pure compile, plan cache,
precompiled shapers, no engine boundary. This is where that gets verified and
where the remaining wins are taken. Nothing here should require restructuring,
and if something does, that is a finding worth writing up.

Read [README.md](./README.md) first, especially the performance contract and
invariant 4.

## Prerequisite state

Iterations 1–6 are merged. The ORM is functionally complete for reads, writes,
relations, transactions and policies.

## Read first

- `packages/gemi/orm/compile/plan-relations.ts` — the strategy stage from
  iteration 3, written to accept a sibling implementation.
- `packages/gemi/orm/shape.ts` — the shaper, which becomes generated code here.
- `packages/gemi/orm/plan.ts` — the cache, whose hit rate is now a measured
  quantity rather than an assumption.

## Deliverables

### 1. Benchmark suite — build this first

No optimisation before measurement. The suite must decompose per query into:

- **compile** (cache miss) and **plan lookup** (cache hit)
- **execute** (driver round trip)
- **shape** (rows → POJOs)

Baselines to compare against, per scenario:

- hand-written SQL through Bun's `SQL` directly — the floor
- Prisma client — the thing being replaced
- gemi ORM

Scenarios, each on SQLite and Postgres:

1. Point read by primary key (latency-dominated; plan-cache and overhead sensitive)
2. `findMany` returning ~1 000 rows (shaping-dominated)
3. Depth-2 `include` over ~100 parents (strategy-dominated — the headline number)
4. Depth-3 `include` (round-trip-dominated on Postgres)
5. `create` and `updateMany`
6. Everything above inside an ambient transaction and with a policy scope
   attached, to price invariants 5 and 6

Report absolute times and the ratio to hand-written SQL. The ratio is the number
that matters; it is what tells you whether there is anything left to win.

Postgres numbers must be taken over an actual socket, not a local Unix socket
only — round-trip count is the whole point of §2 and a loopback benchmark hides it.

### 2. `LATERAL` + `json_agg` relation strategy (Postgres)

The sibling strategy iteration 3 was structured for. One round trip, no row
explosion, and the database does the nesting:

```sql
-- sketch
select u."id", u."email", a.accounts
from "User" u
left join lateral (
  select json_agg(json_build_object('id', a."id", 'publicId', a."publicId")) as accounts
  from "Account" a where a."userId" = u."id"
) a on true
```

Notes that matter:

- Shaping collapses to a native `JSON.parse` — often the largest single win on
  deep includes, since it moves per-row JavaScript into C.
- **JSON aggregation flattens types.** Dates become strings, numerics may become
  strings, `Bytes` needs care. The decoder must be aware of both dialect *and*
  strategy. The differential harness is what catches this; run the full nested
  matrix through the new strategy, not a subset.
- Empty to-many must still shape to `[]`, not `null`. `json_agg` over zero rows
  returns `NULL`; `coalesce` it.
- Policy scopes land inside the lateral subquery automatically, because policies
  rewrite args before planning. Add a test that proves it under this strategy
  specifically — it is the load-bearing claim of invariant 4.

SQLite has `json_group_array` / `json_object` and the same shape is expressible,
but SQLite is in-process so round trips are nearly free. Implement it only if the
benchmarks say it wins; do not assume.

### 3. Strategy selection

Once two strategies exist, something must choose. Start with a rule simple enough
to explain — for example: lateral on Postgres when the include tree has depth ≥ 2
or the parent count is expected to be large, batched otherwise — and make it
overridable per query for escape-hatch cases.

Whatever the rule, it must be **observable**: a way to ask which strategy a query
used, for tests and for debugging. A silent planner is untestable.

### 4. Generated shapers

Today the shaper is built per plan by closing over a description. Faster: generate
the shaping function per plan shape — either a monomorphic closure chain or, if
benchmarks justify it, a compiled function body. Measure before choosing; a
compiled-body approach costs debuggability and may be disallowed in some
deployment targets.

Also evaluate **positional row mode**: if Bun's `SQL` can return rows as arrays
rather than objects, index-based shaping skips per-row key hashing on both the
driver and our side. Verify the API exists before planning around it. This is
likely the largest remaining win on the 1 000-row scenario.

### 5. Take the measurements the earlier iterations deferred

Several iterations explicitly deferred a cost question here. Answer them:

- ALS overhead per query (iteration 5) — the second store is on every query's hot
  path, and if it is expensive the design deserves revisiting.
- Policy dispatch cost per node, especially any async hook (iteration 6).
- Parent-key stitching cost on wide results (iteration 3).
- Plan-cache hit rate under a realistic query mix, and whether an unbounded `Map`
  is acceptable or wants an LRU bound.

### 6. Column selection

Confirm no query emits `SELECT *` and that the default column set matches
Prisma's default (all scalars) — DX parity — while `select` genuinely narrows the
emitted columns. Both are correctness properties with performance consequences.

## Acceptance criteria

1. Benchmark suite runs on demand, reports compile / execute / shape separately,
   and compares against hand-written SQL and Prisma across all six scenarios on
   both dialects.
2. Numbers committed to the repo alongside the machine and versions they were
   taken on, so later regressions are visible.
3. Lateral strategy passes the **full** nested differential matrix from
   iteration 3, including type decoding and empty-to-many shaping.
4. A policy-scoped nested read under the lateral strategy is correctly scoped.
5. Strategy selection is observable and tested.
6. Any shaper change is justified by a before/after number in the PR, not by
   reasoning.
7. Deferred measurements from iterations 3, 5 and 6 are answered with numbers.
8. `bun run lint` and `bun run test` pass; differential harness green on both
   strategies.

## Out of scope

MySQL / MariaDB tuning, query-plan analysis or index advice, connection-pool
tuning (Bun's concern), caching of *results* (a different feature with different
invalidation problems — do not let it in through the plan cache).

## Notes and risks

- **The risk in this iteration is optimising the wrong stage.** Deliverable 1 is
  ordered first for that reason. If execute dominates, nothing in §2 or §4 will
  move the total and the effort belongs in indexes or round-trip count instead.
- **The lateral strategy doubles the surface of relation loading.** Two
  implementations means two places for shape divergence. The differential harness
  must run the full matrix against both, and CI should exercise both rather than
  only the default.
- **A regression guard is worth more than a one-off number.** If a lightweight
  benchmark can run in CI, even at coarse resolution, it protects the ratios that
  justify the project. Consider it, but do not let a flaky perf test become a
  reason to ignore CI.
