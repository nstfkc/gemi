# Iteration 4 — Writes

**Goal.** The full write surface: `create`, `createMany`, `update`, `updateMany`,
`delete`, `deleteMany`, `upsert` — with client-side defaults, `@updatedAt`, and
`select` / `include` on the returned record.

After this iteration the ORM covers everything the template application actually
does today, which makes it the first point at which a real migration off the
Prisma client is conceivable.

Read [README.md](./README.md) first.

## Prerequisite state

Iterations 1–3 are merged. Reads, including nested relations, work on SQLite and
Postgres and are covered by the differential harness.

## Read first

- `packages/gemi/orm/compile/` — writes reuse the where compiler for
  `update` / `delete` filters. They should not grow a parallel one.
- `packages/gemi/orm/schema.ts` — `DefaultSpec` and `isUpdatedAt`, emitted in
  iteration 1 for exactly this moment.
- `packages/gemi/database/dialect.ts` — the note on `RETURNING` support differing
  per dialect is the reason this iteration is dialect-heavy.
- `templates/saas-starter/prisma/schema.prisma` — `@default(autoincrement())`,
  `@default(cuid())`, `@default(now())`, `@default("en-US")`, `@updatedAt`, and
  nullable FKs. All the default kinds appear in this one schema.

## Deliverables

### 1. Operations

`create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`, `upsert`.

All through `$exec` (invariant 1). All compiled through the same plan/bind split
(invariant 2) — `create` with the same field set is one plan regardless of values.

`createMany` with a variable row count has the same variable-length text problem
as `in`. Same decision, same mechanism: either the row count enters the
structural hash, or a dialect-specific multi-row form keeps one text. Do not
invent a third approach.

### 2. Client-side defaults

`cuid()` and `uuid()` are generated in JavaScript, before binding. `now()` and
`@updatedAt` likewise, so that a single logical operation gets one consistent
timestamp rather than several database-clock values.

Match Prisma's behaviour exactly — the differential harness compares results, and
a `cuid` that is shaped differently from Prisma's will show up as a diff in
column length or prefix. Check which cuid version the installed Prisma emits
rather than assuming.

`autoincrement()` stays with the database.

`@updatedAt` applies on `update` and `updateMany`, and on `create`. Missing the
create case is an easy and quiet bug.

### 3. `RETURNING` and its absence

- Postgres: `RETURNING`.
- SQLite: `RETURNING` (3.35+; Bun's bundled SQLite is well past that — verify
  once and record the version in a comment).
- MySQL / MariaDB: no `RETURNING`. Out of scope, but do not write code that
  assumes it away — the dialect interface gets a `supportsReturning` capability
  and the fallback path (`lastInsertRowid` plus a re-select) is left unimplemented
  behind a clear error.

`createMany` returning `{ count }` versus returning rows differs by dialect and
by Prisma option. Follow Prisma.

### 4. `select` / `include` on write results

Prisma allows `create({ data, select })` and `update({ data, include })`. Under
`RETURNING` a scalar `select` is a column list on the returning clause; an
`include` is a follow-up read through the relation planner from iteration 3 —
the same code path, not a new one.

This is the first place a single logical operation issues more than one
statement without a transaction wrapping it. Note the gap; iteration 5 closes it.
Consider whether to close it here with an implicit transaction, or to leave it
and let iteration 5 make it automatic. Leaving it is defensible for one
iteration, but it must be a recorded decision, not an oversight.

### 5. Nested writes — `connect` and shallow `create` only

- `data: { user: { connect: { id } } }` → set the foreign key.
- `data: { user: { create: { ... } } }` → insert the parent, then the child with
  the resulting key.

Everything else in Prisma's nested-write grammar — `connectOrCreate`, `set`,
`disconnect`, `update`, `upsert`, `deleteMany` nested in an update — throws
`UnsupportedQueryError` naming the operation. Deep nested writes are a large
feature with real ordering and cascade semantics; they are not part of this
iteration and should not be smuggled in.

Nested `create` is inherently multi-statement, which is the second argument for
resolving the transaction question in §4.

### 6. Type coercion on the way in

The mirror of iteration 1's `decode`: `encode`. `Date` → integer milliseconds on
SQLite, boolean → `0` / `1`, `Json` → serialized text, `BigInt` and `Decimal`
per dialect. Round-tripping is the test — write a value, read it back, compare
against Prisma doing the same.

### 7. Constraint violations

A unique-constraint violation must surface as a typed error carrying the
constraint and fields, not a raw driver error. Prisma throws
`PrismaClientKnownRequestError` with code `P2002`, and application code in the
template may already branch on it.

Decide whether to mirror Prisma's codes or define gemi's own, and write it down.
Mirroring eases migration; defining our own avoids implying broader Prisma
error compatibility than we deliver. Either way the error must be catchable and
must name the constraint. SQLite and Postgres report violations differently, so
this is a dialect-interface concern.

## Acceptance criteria

1. All seven operations work on SQLite and Postgres.
2. Differential harness green on writes: values written by gemi and by Prisma
   produce identical rows when read back by both.
3. Defaults: `cuid`, `uuid`, `now`, static values, and `@updatedAt` on both
   create and update — each covered.
4. Round-trip coercion tests for `DateTime`, `Boolean`, `Json`, `BigInt`,
   `Decimal` on both dialects.
5. `select` and `include` on write results, tested.
6. Nested `connect` and shallow `create` work; every other nested-write key
   throws `UnsupportedQueryError` naming itself.
7. Unique-violation error is typed, catchable, names the constraint, and behaves
   identically on both dialects.
8. Plan cache still discriminates — `create` with different field sets must not
   collide.
9. `bun run lint` and `bun run test` pass.

## Out of scope

Deep nested writes, cascade emulation (the database's own `ON DELETE` rules
apply and that is fine), MySQL / MariaDB write paths, transactions (iteration 5 —
though this iteration should note every place it wants one), policies on writes
(iteration 6).

## Notes and risks

- **Column order in a multi-row `createMany` must be canonical**, derived from the
  schema rather than from the first row's key order. Otherwise two calls with the
  same fields in different key order produce different SQL and different plan
  entries — and, worse, a row whose keys are ordered differently from the first
  binds into the wrong columns. This is a data-corruption-shaped bug; write the
  test for it.
- **Rows with different key sets in one `createMany`** are legal in Prisma
  (missing keys take defaults). Under a single multi-row `INSERT` they are not
  directly expressible. Either group rows by key set or fill defaults explicitly.
  Decide and test.
- **`updateMany` returns `{ count }`**, and getting the affected-row count out of
  Bun's client differs by dialect. Check the driver's result metadata early; it
  can quietly force a different statement shape.
