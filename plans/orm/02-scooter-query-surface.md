# Iteration 2 — Scooter: the full read surface

**Goal.** Every read operation that does not involve a relation, on both SQLite
and Postgres, verified against Prisma by differential testing.

After this iteration the ORM is genuinely usable for a large fraction of real
queries. It is also the iteration that proves the compiler design, because the
where-operator set is where a bad `Fragment` abstraction shows itself.

Read [README.md](./README.md) first.

## Prerequisite state

Iteration 1 is merged: the `generator gemi` block in `schema.prisma` produces
`app/models/generated/**` on `prisma generate`, and
`User.findMany({ where: { email } })` works end to end on SQLite through
`Model.$exec` → plan cache → compile → shape.

## Read first

- `packages/gemi/orm/compile/` and `plan.ts` from iteration 1.
- `packages/gemi/orm/dialect/sqlite.ts` — the interface Postgres must satisfy.
- `packages/gemi/database/dialect.ts` — `inferDialect`, and the note explaining
  why gemi infers the dialect a second time rather than asking Bun.
- `templates/saas-starter/prisma/schema.prisma` — note the composite uniques on
  `SocialAccount` (`@@unique([username, provider])`) and `MagicLinkToken`. They
  are what `findUnique` must accept as compound keys.

## Deliverables

### 1. Operations

Add to the generated bases and to `$exec`:

- `findMany`, `findFirst`, `findFirstOrThrow`
- `findUnique`, `findUniqueOrThrow`
- `count`

`findUnique` must reject a `where` that is not a declared unique — single-field
`@unique`, the `@id`, or a composite `@@unique` in Prisma's compound form
(`{ username_provider: { username, provider } }`). This validation is compile-time
in the SQL sense (it happens once per shape, in the compiler) and must produce a
clear error, not a wrong query.

`*OrThrow` variants throw `RecordNotFoundError`. Match Prisma's semantics for
what counts as not-found, since the differential harness will compare them.

### 2. Full scalar `where`

Operators: `equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`, `contains`,
`startsWith`, `endsWith`. Logical: `AND`, `OR`, `NOT`, arbitrarily nested. Null
handling: `null` means `IS NULL`, and `not: null` means `IS NOT NULL` — Prisma's
semantics, which differ from naive `= NULL`.

Two traps worth naming up front:

- **`in` with a variable-length array breaks the plan cache.** `in: [1,2]` and
  `in: [1,2,3]` are different SQL texts. Either include the array length in the
  structural hash (simple, some cache churn) or use a dialect-specific
  array-parameter form (`= ANY($1)` on Postgres) that keeps one text for all
  lengths. Prefer the latter on Postgres, the former on SQLite. Document the
  choice where the hash is computed.
- **`mode: "insensitive"`** is Postgres-only in Prisma. SQLite's `LIKE` is already
  case-insensitive for ASCII, which means the two dialects disagree by default —
  the differential harness will catch this only if it runs on both. Decide and
  document the semantics rather than letting them fall out of the implementation.

### 3. `orderBy`, `skip`, `take`

`orderBy` accepts an object or an array of objects, `asc` / `desc`, and Prisma's
`{ sort, nulls }` form. Column names come from the schema; the direction is a
closed set. Neither is ever a parameter, both are structural, so they belong in
the plan key.

`skip` and `take` are values and therefore parameters, not literals. This is the
single most tempting place to inline a number — don't.

### 4. Scalar `select`

`select` restricting to scalar fields. Relations stay out until iteration 3, and
a `select` naming a relation must throw `UnsupportedQueryError`.

This is the first time the emitted column list varies by query, so it is the
first real test of the shaper: the shaper is built from the selection, once per
plan, and the result must contain exactly the selected keys — no extras, no
`undefined` placeholders. Prisma returns exactly the selected keys and the
differential harness will compare key sets.

Note that `select` and `include` are mutually exclusive in Prisma. Enforce it.

### 5. Postgres dialect

`packages/gemi/orm/dialect/postgres.ts`:

- `$1`-style placeholders — the plan's `bind` already returns an ordered array,
  so this should be an interface implementation and nothing more. If it isn't,
  the dialect seam is leaking and that is worth fixing now rather than in
  iteration 4.
- Identifier quoting with `"`.
- `decode` is largely a pass-through: unlike SQLite, Postgres returns real
  timestamps and booleans. The asymmetry is the point — the same query returns
  the same JavaScript values on both dialects, which is the contract the
  differential harness checks.

Add a Postgres test target. Docker or a `DATABASE_URL` env var pointing at a
scratch database, skipped when unset — but make the skip loud, so nobody
mistakes "skipped" for "passed".

### 6. Differential test harness

The core deliverable of this iteration. A helper that takes a model, an
operation, and args; runs both Prisma and gemi against the same database; and
deep-equals the results.

```ts
// sketch
await expectSameAsPrisma(User, "findMany", {
  where: { email: { contains: "@" }, deletedAt: null },
  orderBy: { createdAt: "desc" },
  take: 5,
});
```

Then a table of cases covering every operator, null handling, empty results,
`take: 0`, ordering ties, and the `Date` / `BigInt` / `Decimal` decode paths.

This harness is the safety net for every later iteration. Spend the time here.
It is also the only practical way to discover the small shape divergences —
`null` vs `undefined`, key presence, numeric types — that are otherwise found in
production.

Run it against SQLite always, and against Postgres when the env var is set.

### 7. Plan cache hardening

Now that shapes vary meaningfully, verify the hash actually discriminates:
different operators, different orderBy directions, different select sets, and
different `in` lengths must not collide. A collision produces a silently wrong
query, which is the worst class of bug in this codebase. Write the adversarial
tests.

## Acceptance criteria

1. All six operations work on SQLite and on Postgres.
2. Differential harness green across the full operator table on both dialects
   (Postgres skipped-with-a-loud-warning when no `DATABASE_URL` is set).
3. Compiler unit tests assert exact SQL text and parameters per dialect for a
   representative set — nested `AND`/`OR`/`NOT`, `in`, null handling, ordering,
   pagination, scalar `select`.
4. `findUnique` with a non-unique `where` throws a clear error naming which
   fields would be required.
5. Plan-cache discrimination tests pass, including the `in`-length case.
6. A `select` naming a relation throws `UnsupportedQueryError`.
7. Not one value is inlined into SQL text anywhere. Verifiable by asserting no
   compiled text contains a digit outside an identifier — worth an actual test.

   **Held, and the proxy has since needed a companion.** The digit check is
   exactly right for the shapes iteration 2 emits and *too strict* for the
   correlated subqueries added after iteration 9: a relation filter emits
   `exists (select 1 from …)`, and that `1` is a structural constant with no
   relation to any argument.

   The two ways to keep using the proxy are both worse than a second check.
   Emitting `select null` changes the SQL to fit its measurement; a
   `.replace("select 1", "")` puts a hole in a security check, and the next
   exception goes through the same hole. So those surfaces assert the property
   itself: no supplied value appears anywhere in the text, **and** every one of
   them comes back from `bind`. The second half is not decoration — "the value is
   not in the SQL" is also satisfied by dropping it, which would be a filter that
   silently matches everything.
8. `bun run lint` and `bun run test` pass.

## Out of scope

`include` and relation `select` (iteration 3), all writes (iteration 4),
transactions (5), policies (6), `cursor`, `distinct`, `aggregate`, `groupBy`.
`cursor` and `distinct` should throw `UnsupportedQueryError`; `aggregate` and
`groupBy` are simply not emitted onto the generated bases.

## Notes and risks

- **The where compiler is the piece most likely to be rewritten if it starts
  wrong.** It should be a recursive function over the arg tree returning
  `Fragment`s, with the parameter array threaded through — not string
  concatenation with a counter in the outer scope. Get this shape right; every
  later iteration extends it.
- **Do not let Postgres branch inline.** The moment `if (dialect === "postgres")`
  appears inside the where compiler rather than behind the dialect interface, the
  branches start multiplying. If something genuinely cannot be expressed through
  the interface, widen the interface.
- **Prisma's `contains` on SQLite** compiles to `LIKE '%x%'` with the pattern as a
  parameter and the wildcards concatenated in SQL or in the binder. Escaping `%`
  and `_` inside user-supplied values is a real correctness issue and Prisma
  handles it; check what it does before choosing, because the differential
  harness will compare against it.
