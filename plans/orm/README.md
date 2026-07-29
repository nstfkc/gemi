# gemi ORM — implementation plan

An ORM for gemi that keeps Prisma's developer experience — including full
`select` / `include` type narrowing — while executing every query itself through
Bun's native `SQL` client. No Prisma query engine, no serialization boundary, no
Prisma client at runtime.

The two things that justify the project, and that Prisma structurally cannot
give us, are **ambient transactions** and **first-class policies that apply to
nested reads**. Performance is the top priority throughout.

## Stack position

This work is a **third level in an open PR stack**. Branch from
`feat/database-layer` and target it, not `main` and not the release branch:

```
main
 └── refactor/laravel-container-architecture   PR #30, OPEN — container/providers
      └── feat/database-layer                  PR #33, OPEN — DatabaseManager, DB facade
           └── feat/orm                        PR #45, OPEN — iterations 1-6
```

### Where it actually is now

Nine levels, not three. Recorded because the diagram above described the state on
the day this plan was written and a reader following it would branch under work
that has since landed on top. **Every one of these is `MERGEABLE`/`CLEAN`** and
each was verified at its own tip; they are listed in merge order.

| PR | Branch | What it adds |
| --- | --- | --- |
| #53 | `feat/orm-08-eloquent-doorway` | opt-in provenance, `save(row)`, `wrap`, the ORM auth adapter |
| #54 | `feat/orm-09-lateral-strategy` | `LATERAL` + `json_agg`, nested policies on the arg tree |
| #56 | `fix/orm-bytes-container` | `Bytes` is a `Uint8Array` on every dialect; the differential harness stops erasing containers |
| #55 | `docs/orm` | `docs/orm.md`, and the two ORM pages linked from all four indexes |
| #57 | `feat/orm-registration-audit` | `assertPoliciesRegistered`, for the policied subclass nobody registered |
| #58 | `feat/orm-relation-filters` | relation filters, `_count`, relation orderings, implicit m-n, and six audit findings |

The two entries under [Open decisions](#open-decisions) are the only remaining
items on this plan; the rest of it is built, and #58's description carries the
audit trail.

### A stacked PR merges into its parent, not into the trunk

Worth its own heading, because it is a property of the shape rather than a
mistake anybody made, and the next stacked effort will meet it again.

Every PR here targets its **parent**, so merging one lands its content on the
immediate parent and **nowhere below**. Nothing re-merges downward on its own. So
after nine PRs were marked merged, `feat/orm` — the branch #45 proposes to
`feat/database-layer` — still carried **iteration 1 alone**, 91 commits behind the
stack tip, with relations, writes, transactions, policies, provenance and lateral
all absent from it.

Merge *order* compounds it. Five of those merges landed within 100 seconds,
bottom-up, and each base was merged before its own child had received the next
one — so the work pooled at different heights:

| branch | had the Bytes fix | had the docs | had the audit |
| --- | --- | --- | --- |
| `feat/orm-07-performance` | no | no | no |
| `feat/orm-09-lateral-strategy` | yes | no | no |
| `docs/orm` | yes | yes | yes |

**The stall starts partway up, not at the bottom**, which narrows where to look.
Each level holds its own child's work and passes none of it down:

```
feat/database-layer                0 ahead of feat/orm              <- landed
feat/orm-03-motorcycle            11 ahead of feat/database-layer   <- stalls here
feat/orm-04-writes                11 ahead of feat/orm-03-motorcycle
feat/orm-05-ambient-transactions  12 ahead of feat/orm-04-writes
feat/orm-06-policies              13 ahead of feat/orm-05-…
feat/orm-07-performance           14 ahead of feat/orm-06-policies
feat/orm-08-eloquent-doorway      15 ahead of feat/orm-07-performance
```

### The runbook

**Detect it.** One command, worth running before treating a stack as shipped,
because every PR showing `MERGED` looks exactly like success:

```
git rev-list --count origin/<trunkward-branch>..origin/<stack-tip>
```

Non-zero means the trunkward branch has not received the stack.

**Then check how much of a repair it is**, because that number reads like one
job per level and is usually one job in total:

```
git rev-list --no-merges --count origin/<stack-tip>..origin/<each-branch>
```

Zero everywhere means no branch holds unique work — what they hold that the tip
does not is only the merge commits their own child PRs created. Measured across
all thirteen branches of this stack: **zero non-merge commits on every one of
them.**

**So the repair is a single merge** of the stack tip into the trunkward branch,
and the intermediates can be deleted rather than repaired one at a time. Without
that second check the first number is alarming and misleading in the expensive
direction: "nine PRs merged and nothing landed" reads as nine repairs.

`feat/database-layer` is at `e3c2e0b`. Everything this plan depends on exists
there — `database/`, `container/`, `foundation/`, `kernel/`, `support/`,
`facades/DB.ts`, `app/prismaExtension.ts`, the template's `schema.prisma` — and
is byte-identical to the copy on `release/v0.50.0-rc.2`, so no ORM work is
blocked by branching low.

What is *not* on the base is unrelated to the ORM: HTTP range requests, the
Azure/S3 storage drivers, the rate-limiter rewrite, and router changes. One
detail does matter, though:

- `packages/gemi/package.json` differs from the release branch. In particular
  **`test:types` (`vitest run --typecheck.only`) does not exist on the base.**
  Iteration 8 needs a compile-time type assertion; add the script or invoke
  vitest's typecheck mode directly.
- Iteration 1 edits this same file (`exports`, `bin`, `build:bin`,
  `devDependencies`). Expect a conflict when the stack eventually lands on
  `main`; it is small and mechanical, but do not be surprised by it.

### Two follow-ups from PR #33 that this plan changes

#33's description schedules its own next steps. The ORM supersedes part of that:

- **`gemi db:setup`** (proposed there to create the 8 auth tables) should be
  **dropped**. Prisma owns schema and migrations, and gemi must not shadow the
  Prisma CLI — the same decision that made generation a Prisma generator block
  rather than a `gemi` subcommand.
- **`SqlUserProvider`** (proposed there as `IAuthenticationAdapter` implemented
  with hand-written dialect-aware SQL) should be built **on the ORM**, once
  iteration 4 lands writes. Hand-rolling per-dialect SQL for 22 adapter methods
  duplicates exactly what the compiler does. This makes the ORM the thing that
  finally lets `auth/adapters/prisma.ts` be deprecated, which is #33's stated
  goal.
- #33 also flags renaming the `gemi migrate` codemod (from #30) to
  `gemi upgrade` — free now, breaking later. With Prisma owning migrations, a
  `gemi migrate` that means "codemod" is actively misleading. Unrelated to the
  ORM, but the reasoning is the same and the window closes when the stack ships.

## Division of labour

| Concern | Owner |
| --- | --- |
| Schema definition (`schema.prisma`) | Prisma |
| Migrations (`prisma migrate`) | Prisma |
| Query argument & result **types** | Prisma (`prisma generate`, type-only import) |
| Runtime model metadata | gemi (a Prisma generator block, run by `prisma generate`) |
| SQL compilation, execution, result shaping | gemi |
| Transactions, policies, hooks | gemi |

`@prisma/client` is generated and imported **type-only**. It never appears in a
runtime import, never ships in a bundle, and the ORM runtime in
`packages/gemi/orm/` must contain zero Prisma imports of any kind.

## The query pipeline

Every operation, including every nested relation read, runs this and nothing
else:

```
args
  → policies      (rewrite the arg tree: deny / scope / redact)
  → plan lookup   (structural hash of the args shape → cached plan)
      ↳ miss: compile → { text, bind, shape }
  → bind          (args → parameter values)
  → execute       (Bun SQL, on the ambient transaction if one is open)
  → shape         (rows → nested POJOs, precompiled per plan)
```

The split between **compile** (shape → SQL text) and **bind** (values →
parameters) is the load-bearing idea. It is what lets us cache plans, what lets
Postgres reuse prepared statements, and what makes SQL injection structurally
impossible. It cannot be retrofitted; it is present from iteration 1.

## The six invariants

Every iteration must preserve these. If a change would break one, stop and raise
it rather than working around it.

### 1. One choke point

`Model.$exec(op, args)` is the only place that touches the database. The twelve
public operations are one-line delegations to it. Nested relation reads
recurse through it too.

Everything cross-cutting — policies, ambient transactions, plan caching,
slow-query logging, metrics — attaches here. A single operation that "just does
a quick insert directly" silently escapes all of it.

### 2. Compile is pure, and split from bind

`compile(model, op, argsShape, dialect) → { text, bind, shape }` is a pure
function of the query's **shape**, never its **values**.

- Two calls with the same shape and different values must produce **byte-identical**
  SQL text.
- Values are **always** parameters. Never interpolate a value into the text —
  not even a literal `take: 10`.
- Identifiers come **only** from the generated schema, never from user input.
  That is the entire injection story, and it holds if we never bend it.
- Arg trees are canonicalised before hashing (key order, `AND` flattening,
  operator normalisation) or identical queries produce duplicate cache entries
  and duplicate prepared statements.

Args stay plain, mutable data until compile. That is what makes a policy a
two-line `AND` into `args.where` instead of SQL string surgery, and it is what
lets the entire compiler be unit-tested with no database at all.

### 3. `shape` is a static on the model class

The result-shaping stage is `static $shape` on the model base, not a module-level
function. Subclassing is the extension mechanism: the `ActiveRecordModel`
base overrides `$shape` to build instances, and every model extending it gets
that with zero changes to the fifteen operations. As a free function, every future
tier becomes a rewrite.

Shaping is per-row JavaScript and it is where ORMs quietly bleed. The plan
carries a **precompiled shaper** built once per query shape, closing over a fixed
list of `(column index → output key, coercer)`. The hot loop stays monomorphic.

### 4. The relation planner is a swappable stage

Three strategies exist and the right one is dialect- and query-dependent:

| Strategy | Round trips | Row explosion | Shaping cost |
| --- | --- | --- | --- |
| Batched separate queries | one per include node | none | JS nesting |
| Plain `JOIN` | 1 | severe on to-many | JS dedup + nesting |
| `LATERAL` + `json_agg` | 1 | none | native `JSON.parse` |

Plain joins are usually the *worst* option for to-many: 100 users × 10 posts × 5
comments is 5 000 rows with the user columns duplicated 50 times. SQLite is
in-process so round trips are nearly free and batching is fine; Postgres over a
network is RTT-dominated and the lateral form wins decisively.

So the planner takes the include tree and emits a strategy. Iteration 3 ships
batching, iteration 7 adds lateral+json. Because policies rewrite the **arg
tree** before planning (invariant 2), scoping applies under every strategy — the
scoped `where` lands inside the lateral subquery exactly as it would in a
separate query.

**Correction 2, found while designing the lateral strategy.** The last sentence
above — that scoping applies under every strategy because policies rewrite the arg
tree before planning — is **not true today**. Policies are applied in
`Model.$exec` to the model being queried, and a nested read acquires its own only
because the batched strategy recurses through the child's `$exec`. A lateral join
compiles the child's SQL inside the parent's compile step and never enters that
call, so the child's policies would be skipped and the subquery would be unscoped.

Making the claim true means applying nested models' policies to the arg tree in
`$exec`, before the plan key — which is what the sentence describes and what the
code does not do. That is iteration 9's deliverable 1c, and it is blocking: the
first version of the lateral strategy must not be one that silently bypasses
policies. See [09](./09-lateral-strategy.md).

**Correction 1, found while starting the lateral strategy.** The seam iteration 3
built is narrower than this claims. A `RelationStrategy` produces a `load()` that
runs *after* the root query, plus a list of field names the root must select for
stitching — and nothing else. It cannot contribute a column expression, a join
clause or a table alias to the root statement, which is all three of the things a
lateral join needs.

So it is genuinely swappable for *"fetch children separately, by some means"* and
closed to *"fold children into the root statement"*. The batching strategy and any
future n+1-avoiding variant fit it; the two single-round-trip strategies in the
table above do not. Widening it is iteration 9's first deliverable —
[09](./09-lateral-strategy.md) — and the widening is additive, so batching is
unaffected. The claim is left standing above with this correction beneath it
rather than quietly rewritten, because the gap between what an invariant promised
and what it delivered is the useful part.

Caveat for iteration 7: JSON aggregation flattens types. Dates come back as
strings, numerics may come back as strings. Coercion must be aware of both
dialect *and* strategy.

### 5. Row provenance is opt-in

`$shape` is the place the `WeakMap<row, { model, pk, snapshot }>` is
populated, enabling `User.save(row)`, which diffs against the snapshot and
writes only changed columns — Eloquent-style writes with POJO return types, no
proxies, no type changes.

It costs a WeakMap insert and a snapshot clone **per row**, which contradicts the
performance priority on large reads. So it is off by default and opted into per
query or per model. Iterations 1–7 only needed the seam to exist; iteration 8
filled it in.

### 6. Lazy, name-keyed model registry

Generated schema references relations by model **name**. The registry resolves
name → class at call time, never at module load.

Without this, `User.ts` imports `Post.ts` imports `User.ts`, and under ESM one of
them is `undefined` during module evaluation. It is the classic ORM bootstrap
failure and it appears the moment two models reference each other — immediately.

It also keeps generated files holding data and strings only, with no import graph.

## Type strategy

Queries return **POJOs**, always. Not class instances. `select` forces this: a
`Pick<User, "id">` hydrated as a `User` would carry methods reading fields the
query never fetched — typed fine, crashing at runtime.

The model class is therefore a namespace for statics: policies, scopes,
observers, and inheritance (`TenantModel` injecting scope into every subclass).

Types come from Prisma verbatim, wired through **concrete generated bases** —
never through a generic base class:

```ts
// app/models/generated/models.ts  (generated; sketch)
export class UserModel extends Model {
  static $schema = schema.User;
  static findMany<T extends Prisma.UserFindManyArgs>(
    args?: Subset<T, Prisma.UserFindManyArgs>,
  ): Promise<Prisma.UserGetPayload<T>[]> {
    return this.$exec("findMany", args);
  }
  // ...11 more, all one-liners
}
```

Threading `Prisma.UserGetPayload` through a generic base would require reaching
into `Prisma.$UserPayload` and `$Result.GetResult` from `@prisma/client/runtime/library`
— internal, and it breaks on version bumps. Concrete per-model bases cost ~12
generated one-liners per model and buy perfect narrowing, fast `tsc`, and
readable error messages. Nobody reads generated code.

**Signatures are final from iteration 1.** The full Prisma arg type is accepted
from the start; capability grows underneath it. Anything not yet implemented
throws `UnsupportedQueryError` naming the offending key. Honest, fixable, and it
means no iteration ever changes a signature.

Two `Omit`s at the operation level rather than the arg level: we never emit
`aggregate`, `groupBy`, or the raw operations. Narrowing recursive where-inputs
via `Omit` is miserable; implementing the operators is easier than excluding them.

## Generated artifacts

gemi does **not** add a CLI command for this and must not shadow the Prisma CLI.
Generation is a Prisma generator block, so `prisma generate` emits both artifacts
in one step and every `prisma migrate dev` refreshes them automatically:

```prisma
generator client {
  provider = "prisma-client-js"
}

generator gemi {
  provider = "gemi-orm-generator"
  output   = "../app/models/generated"
}
```

```
prisma migrate dev     # schema + migrations                     (unchanged)
prisma generate        # → Prisma types (type-only import)
                       # → gemi runtime schema + model bases
```

The generator is a small stdio process built on `@prisma/generator-helper` (a
devDependency of `packages/gemi`, exposed as a second `bin`). Prisma hands it the
DMMF directly, so nothing needs to parse `schema.prisma`. It writes:

```
app/models/generated/
  schema.ts     runtime metadata: table & column names, scalar types, uniques,
                relation topology, defaults, @updatedAt, artifact version
  models.ts     one concrete base class per model
  index.ts      registry registration
```

Rules for generated output:

- **Committed**, not gitignored — diffs stay reviewable and CI needs no codegen step.
- **Data and thin delegating methods only, never logic.** We regenerate constantly;
  anything smart in there cannot be hotfixed without a codegen release.
- **Emit richer metadata than the current iteration consumes** (cascades,
  soft-delete markers, `@updatedAt`, composite uniques). Regenerating is free;
  changing the emitted schema's *shape* after apps depend on it is not.
- **Version the artifact** so the runtime can refuse a stale one with a clear message.
- **Dialect-agnostic.** Prisma tells the generator which datasource provider is
  configured, but the dialect is a *runtime* property — `DATABASE_URL` can point
  at a different database than the one generation saw. The dialect stays resolved
  per call from `DatabaseManager`; nothing dialect-specific is ever baked into a
  generated file.

Note on the template's schema: it uses no `@map` / `@@map`, so table names are
the model names verbatim (`"User"`, `"Account"`) and column names are the field
names. The compiler must read both from the schema and must never infer,
pluralise, or snake_case anything.

## Performance contract

Where Prisma's time actually goes, and what we do about each:

| Prisma cost | Our answer |
| --- | --- |
| Rust engine boundary + JSON serialization each way | Gone. In-process compile, native Bun driver. Free win, and the largest one. |
| Recompiles args → SQL on every call | Plan cache keyed on args **shape** (invariant 2). |
| One query per include node, RTT-heavy | Swappable planner; lateral+json on Postgres (invariant 4). |
| Per-row JS shaping with key lookups | Precompiled shaper; positional row mode where Bun supports it (invariant 3). |
| Selects all scalars by default | Match Prisma's default for DX parity, but never `SELECT *` — always an explicit column list. |

The benchmark that would justify the project: a nested `include` on Postgres,
measured against hand-written SQL through Bun, with **compile, execute and shape
timed separately**. That decomposition tells us which stage we are losing to.
Iteration 7 builds it; earlier iterations should not guess.

## Module layout

```
packages/gemi/orm/
  index.ts            public exports
  Model.ts            base class, $exec choke point
  registry.ts         lazy name-keyed model registry
  schema.ts           runtime metadata types
  plan.ts             QueryPlan, plan cache, structural hashing
  shape.ts            shaper construction
  errors.ts           UnsupportedQueryError, RecordNotFoundError, ...
  compile/            arg tree → SQL fragments
  dialect/            Dialect strategy: sqlite.ts, postgres.ts
  context.ts          ambient transaction ALS
  policy.ts           policy hook                        (iteration 6)

packages/gemi/bin/orm-generator.ts  Prisma generator plugin: DMMF → artifacts.
                                    Its own `bin` entry, spawned by `prisma
                                    generate`. Not a `gemi` subcommand.
```

Add `"./orm": "./orm/index.ts"` to the `exports` map in
`packages/gemi/package.json`.

Framework internals on model classes take a `$` prefix (`$exec`, `$schema`,
`$shape`, `$policies`) so they cannot collide with anything an app author adds.

## Testing strategy

Three layers, introduced in this order:

1. **Compiler unit tests** — no database. Assert exact SQL text and the exact
   parameter array for a given arg tree, per dialect. These are the fast,
   high-volume tests and they are only possible because compile is pure.
2. **Differential tests against Prisma** — run the same query through both
   clients against the same database and deep-equal the results. Our result shape
   is a contract with Prisma's, and it is fiddly: `select` inside `include`,
   `null` vs `undefined` on optional relations, Dates from SQLite integers,
   BigInt, JSON columns. Build this harness in iteration 2, not iteration 10.
3. **Benchmarks** — iteration 7, with compile / execute / shape timed separately.

Existing conventions: vitest, tests colocated as `*.test.ts` next to the code
(see `packages/gemi/database/dialect.test.ts`). `bun run test` in `packages/gemi`.

Assert differential equality against the **pre-`$shape`** payload once anything
gemi-specific (provenance, future computed fields) lands, so the contract stays
testable as we diverge.

## Iteration map

Each iteration ends with something that runs. Each is written to be picked up
with no prior context.

| # | Vehicle | Ships | Doc |
| --- | --- | --- | --- |
| 1 | Skateboard | Prisma generator plugin, `findMany` with equality `where`, SQLite, end to end | [01](./01-skateboard-generate-and-read.md) |
| 2 | Scooter | Full read surface: all operators, `orderBy`, pagination, scalar `select`, `count`; Postgres; plan cache; differential harness | [02](./02-scooter-query-surface.md) |
| 3 | Motorcycle | `include` and nested `select`/`include` via the batched planner | [03](./03-motorcycle-relations.md) |
| 4 | | Writes: create / update / delete / upsert families, defaults, `RETURNING` | [04](./04-writes.md) |
| 5 | | Ambient transactions | [05](./05-ambient-transactions.md) |
| 6 | Car | First-class policies, including nested reads | [06](./06-policies.md) |
| 7 | | Performance: lateral+json planner, generated shapers, benchmark suite | [07](./07-performance.md) |
| 8 | | Eloquent doorway: opt-in provenance, `save(row)`, entity tier | [08](./08-eloquent-doorway.md) |
| 9 | | `LATERAL` + `json_agg`: iteration 7's deliverable 2, declined then re-justified on corrected measurements | [09](./09-lateral-strategy.md) |

Iterations 5 and 6 are the reason the project exists, but they are cheap *once
the choke point exists*, which is why they come after the query engine rather
than before it.

**All nine have shipped.** What remains on this plan is not another vehicle: it
is the two entries under [Open decisions](#open-decisions) that are decisions
rather than work, and whatever the ORM's first real users find.

### Documentation

`docs/orm.md` is the user-facing page — setup through the Prisma generator
block, the fifteen operations, relations and the two strategies, ambient
transactions, policies, soft deletes, the typed errors, and an explicit
*not in scope* section. It sits beside `docs/orm-rows-and-entities.md`, which
iteration 8 wrote and which nothing linked to: neither page was reachable from
`docs/README.md`, `docs/index.html`, `docs/llms.txt` or `docs/llms-full.txt`
until the doc pass. Both are now in all four.

Two deliberate omissions, so the next person does not read them as oversights:

- **No measured numbers.** They live in `plans/orm/benchmarks.md`, generated
  from `benchmarks.json`. Copying them into `docs/` would produce prose that
  drifts from its own source — which happened three times inside the benchmark
  document itself before the numbers were derived rather than written.
- **Nothing about internals.** `$exec`, the plan key, `Fragment`/`Binder`, the
  strategy seam and the six invariants are all in this directory. An
  application author does not need them, and documenting them in `docs/` would
  make them a compatibility surface.

## Running the Postgres suites

`templates/saas-starter/app/models/postgres.sh`. Four steps have to happen in
order — a server, `provider = "postgresql"`, `db push`, `prisma generate` — and
**getting it wrong does not error.** The suite runs, the Postgres describes skip
or fail, and the number at the bottom looks like a result: 121 failures that are
nothing but a client generated for the other dialect.

That misread happened three times in one sitting, each time costing a few
minutes of reading a "regression" that was not one. The script also restores
`provider = "sqlite"` on the way out, because a left-over `postgresql` provider
makes the *SQLite* suites fail for an unrelated reason afterwards.

## Picking up an iteration

0. Confirm you are on a branch descended from `feat/database-layer` (see
   [Stack position](#stack-position)), not from `main` or a release branch.
1. Read this file, then the iteration's doc.
2. Read the "Read first" list in that doc before writing anything.
3. Respect the six invariants. If one is in the way, raise it — do not work around it.
4. Satisfy the acceptance criteria literally; they are meant to be executable.
5. Anything in "Out of scope" belongs to a later iteration. Leave it alone.

## Open decisions

- ~~**Ambient transaction storage.**~~ **Settled in iteration 5: a second,
  ORM-owned `AsyncLocalStorage`** in `packages/gemi/orm/context.ts`, holding
  `{ tx, depth }` and nothing else. `packages/gemi/kernel/context.ts` keeps
  carrying only the Application, and the reasoning for a second store rather
  than a wider one is written up there so the "exactly one ALS" claim does not
  silently become false. The two alternatives were rejected on the record:
  re-entering the kernel store with a `{ app, tx }` wrapper makes every reader
  of it — `app()` above all — handle two shapes forever, and hanging the handle
  off the Application shares it across concurrent requests, which is data
  corruption rather than a style question.
- **MySQL / MariaDB.** Deferred. `DatabaseManager` already infers all four
  dialects, and the strategy seam keeps the door open, but only SQLite and
  Postgres are built and tested. Confirm this is acceptable.
- ~~**Implicit many-to-many.**~~ **Covered.** Iteration 3 built the dedicated
  fixture this asked for —
  `templates/saas-starter/app/models/relations.many-to-many.test.ts` — a
  `Post`/`Tag` pair with the DDL taken verbatim from
  `prisma migrate diff`, exercising the two-hop load through `_PostToTag` in both
  directions, on both dialects. Iteration 9 added the case that the lateral
  strategy *declines* this shape and falls back to batching with identical rows.
  Still true, and worth keeping in view: the template's own schema has no m-n, so
  the differential harness cannot reach one and this fixture asserts against
  Prisma's documented shape rather than a second generated client.
- ~~**Coexistence.**~~ **Built.** `OrmAuthenticationAdapter` ships alongside the
  Prisma one — both satisfy `IAuthenticationAdapter`, so an application selects
  one and nothing else in `auth/` knows which. All twenty-two methods translated
  with no changes to the ORM, which is the first evidence the query surface is
  *sufficient* rather than merely tested: they were written against a real
  application's needs rather than against the compiler's known capabilities.
  `packages/gemi/auth/adapters/prisma.ts` and the template's
  `app/database/prisma.ts` are untouched.

  **Still open, and a decision rather than work:** the template's
  `app/config/auth.ts` is not pointed at it. That is a behaviour change to a
  working application and wants its own call.
- **Where this stack merges.** PRs #30 and #33 are both open. If they land before
  the ORM is ready, rebase onto whatever they merge into rather than carrying a
  three-deep stack longer than necessary.
