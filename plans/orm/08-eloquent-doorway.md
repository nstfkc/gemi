# Iteration 8 — The Eloquent doorway

**Goal.** Take the first step past the POJO baseline without breaking it:
opt-in row provenance, `User.save(row)` with dirty tracking, and an explicit
entity tier for code that wants instances.

This iteration is optional in the sense that iterations 1–7 stand on their own.
It exists because the architecture was built to allow Eloquent-level ergonomics
later, and this is the cheapest, least invasive step in that direction — nothing
here changes a return type or a signature.

Read [README.md](./README.md) first, especially invariants 3 and 5.

## Prerequisite state

Iterations 1–7 are merged. Queries return POJOs, `$shape` is a static on the
model base, and the provenance seam exists but is unpopulated.

## Read first

- `packages/gemi/orm/shape.ts` and `Model.ts` — `$shape` is the extension point
  everything here hangs off.
- The type-strategy section of [README.md](./README.md) — the reasoning for POJOs
  is what constrains this iteration, and it has not changed.
- [07-performance.md](./07-performance.md) — the shaping numbers, which set the
  budget for anything added to the per-row path.

## Deliverables

### 1. Opt-in provenance

Populate `WeakMap<row, { model, pk, snapshot }>` in `$shape`, **only** when
requested:

- per query: `User.findMany({ ..., $track: true })`
- per model: a static flag on the class

Off by default, because it costs a WeakMap insert and a snapshot clone per row
and iteration 7 has by then measured what that means on the 1 000-row scenario.
Include the cost in the PR.

The snapshot only needs the columns actually fetched. A partially selected row
can still be saved — it just cannot write columns it never read, which is the
correct behaviour anyway.

### 2. `Model.save(row)`

```ts
const user = await User.findUnique({ where: { id }, $track: true });
user.name = "new name";
await User.save(user);   // update "User" set "name" = ? where "id" = ?
```

Diff against the snapshot, write only changed columns, no-op when nothing
changed. Compiles through the same plan/bind split as everything else — the
changed-column *set* is the shape, the values are parameters.

Error clearly when handed an untracked object: it means `$track` was not set, and
the message should say so directly.

This delivers most of Eloquent's write ergonomics while returns stay plain
objects — no proxies, no conditional return types, no change to any signature.
That is the whole point of invariant 5.

Policies apply, as with any other write. `@updatedAt` applies. Both are tested.

### 3. The entity tier

For code that genuinely wants behaviour, an explicit wrapper rather than implicit
hydration:

```ts
const user = User.wrap(await User.findUniqueOrThrow({ where: { id } }));
user.displayName;
await user.save();
```

`wrap` accepts only a **complete** row — a partially selected result must not
compile. That single constraint is what lets instances and `select` coexist:
narrowing and behaviour never meet, because the type system keeps them apart.

Typing this precisely is the interesting part. `wrap` should require the full
scalar field set; a `Pick` of it should be a type error, not a runtime surprise.

### 4. `ActiveRecordModel` as a `$shape` override

Demonstrate that invariant 3 pays: a base class that overrides `$shape` to
construct instances, giving every model extending it hydrated results with zero
changes to any of the twelve operations.

Ship it as a documented example rather than a supported tier unless there is
demand. Its purpose here is to prove the seam works — if overriding `$shape`
turns out to require touching the operations, that is a design defect to fix
now, while the cost is still small.

### 5. Documentation

A page in `docs/` covering the three levels and when to use each: POJOs by
default, `$track` + `save` for mutate-and-persist, `wrap` when behaviour is
wanted. The framing matters — these are three deliberate levels, not one
unfinished abstraction.

## Acceptance criteria

1. Provenance is off by default; measurably zero added per-row cost when off.
2. `$track: true` populates provenance; `save` writes only changed columns and
   no-ops on an unchanged row.
3. `save` on an untracked object throws a clear, actionable error.
4. `save` respects policies and `@updatedAt`.
5. A partially selected row can be saved, and cannot write unfetched columns.
6. `User.wrap` rejects a partial row **at compile time** — a type test, not a
   runtime test.
7. `ActiveRecordModel` works purely by overriding `$shape`, with no changes to any
   operation. If it cannot, that is a finding to report rather than a workaround
   to write.
8. Benchmarks show no regression on the default path.
9. `bun run lint` and `bun run test` pass.

## Out of scope — and deliberately so

**Identity map, unit of work, deferred flush, lazy relation loading on
instances.** Full Doctrine/Hibernate-style active record is months of work and
brings flush ordering across foreign keys, cascade semantics, stale-instance
invalidation, and a request-scoped identity map that is a memory leak and a
cross-tenant data leak if scoped wrong.

Half an identity map is worse than none. If this tier is ever pursued it needs
its own plan, and the decision should be that the ORM is the product rather than
one component of the framework. Until then, say so in the docs so nobody builds
against a half-promise.

## Notes and risks

- **`$track` as an argument key sits inside Prisma's arg types**, which do not
  have it. It will need to be threaded around the type or accepted as a second
  parameter. Prefer whichever keeps `Prisma.UserFindManyArgs` usable verbatim —
  a second parameter is probably cleaner than intersecting every args type.
- **A WeakMap keyed on result objects** is correct for garbage collection, but a
  row that is spread, cloned, or round-tripped through JSON loses provenance
  silently. `save` must fail loudly in that case rather than guessing, and the
  documentation should call it out — it is the first thing someone will hit.
- **Do not let `wrap` become implicit.** The moment queries hydrate by default,
  the `select` conflict from the very first design discussion comes back, and the
  type system stops protecting against methods that read unfetched fields.
