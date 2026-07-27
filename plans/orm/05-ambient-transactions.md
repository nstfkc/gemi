# Iteration 5 — Ambient transactions

**Goal.** `Model.transaction(cb)` — every query inside the callback, at any call
depth, joins the transaction automatically. No `tx` threaded through function
signatures.

This is one of the two features that justify the project. Prisma structurally
cannot do it: its `$transaction` hands you a distinct client and every
participating function must accept it, which pushes the transaction into every
signature between the boundary and the query.

Read [README.md](./README.md) first.

## Prerequisite state

Iterations 1–4 are merged. Reads and writes work on both dialects. Every query
already goes through `Model.$exec`, which resolves its connection per call from
the container — that resolution point is the whole hook.

## Read first

- `packages/gemi/kernel/context.ts` — **the framework's only `AsyncLocalStorage`**.
  It holds the Application.
- `packages/gemi/foundation/app.ts` — reads that ALS, falling back to the static
  instance. Read the comment; it explains the single-ALS design.
- `packages/gemi/facades/DB.ts` — already has `DB.transaction(fn)` delegating to
  Bun's `sql.begin`. This iteration must not break it.
- `packages/gemi/orm/Model.ts` — the `$exec` connection-resolution line.

## The open decision this iteration must settle

`packages/gemi/kernel/context.ts` deliberately holds *one* ALS, and it carries
the Application. `Kernel.run()` enters it once per request. A transaction scope
has to nest **inside** that without replacing the Application, so it cannot reuse
the same store.

Proposal: a second, ORM-owned ALS in `packages/gemi/orm/context.ts` holding only
`{ tx, depth }`.

This is a conscious deviation from a documented design choice and needs sign-off
before the code lands. The alternatives are worse: storing the handle on the
Application makes it shared across concurrent requests (a correctness bug, not a
style one), and re-entering the kernel ALS with a wrapper risks the Application
lookup in `app()` finding the wrong thing.

Whatever is decided, write the reasoning into a comment in `context.ts` next to
the existing one, so the "exactly one ALS" claim there does not silently become
false.

## Deliverables

### 1. `packages/gemi/orm/context.ts`

The ALS and its accessors. Small, and the only place that knows a transaction is
ambient.

### 2. `Model.transaction(cb)`

```ts
// sketch
static async transaction<T>(fn: () => Promise<T>): Promise<T> {
  const current = ormContext.getStore();
  if (current?.tx) {
    return current.tx.savepoint((sp) =>
      ormContext.run({ tx: sp, depth: current.depth + 1 }, fn),
    );
  }
  const db = app(DatabaseManager);
  return db.sql.begin((tx) => ormContext.run({ tx, depth: 0 }, fn));
}
```

Note the callback takes **no argument**. Handing the caller a `tx` would
reintroduce exactly the threading this feature exists to remove. If an escape
hatch is needed, expose the current handle through a separate accessor.

### 3. Nesting via savepoints

A nested `Model.transaction` inside an open one becomes a savepoint: it rolls
back to the savepoint on failure without killing the outer transaction. Verify
Bun's `SQL` savepoint API and its naming before relying on it, and confirm
savepoint support on both target dialects.

### 4. `$exec` picks it up

One line: `const conn = ormContext.getStore()?.tx ?? app(DatabaseManager).sql`.

That is the entire integration, and it works for every operation and every nested
relation read only because invariant 1 held through iterations 1–4. If some
operation acquired a private path, this is where it shows up as a query silently
running outside the transaction — which is why iteration 3's acceptance criterion
3 exists.

### 5. Interaction with the plan cache

The plan cache is keyed on dialect, model, operation and args shape — not on
connection. That is correct and must stay so: a plan compiled outside a
transaction is valid inside one. Add a test asserting no cache pollution rather
than leaving it to be inferred.

### 6. `DB.transaction` compatibility

`DB.transaction(fn)` currently passes a raw `tx` to its callback. It must keep
working unchanged for existing code. Decide whether it also populates the ORM
context so that ORM calls inside a `DB.transaction` join it — almost certainly
yes, since the alternative is two transaction systems that silently ignore each
other. Test the mixed case explicitly: a `DB.transaction` containing a
`User.create`, and a `Model.transaction` containing a raw `DB.sql` query.

### 7. Concurrency safety

The property that matters: two concurrent requests, each in its own transaction,
must never see each other's handle. Write the test that would fail if the handle
were stored anywhere but an ALS — run two overlapping transactions with
interleaved awaits and assert isolation.

### 8. Errors and rollback

- Throwing inside the callback rolls back and rethrows the original error.
- Nested failure rolls back to the savepoint and lets the outer transaction
  continue if the caller catches.
- Returning normally commits.
- A query issued after the callback resolves must use the pool connection, not
  the closed transaction handle.

## Acceptance criteria

1. `Model.transaction` commits on success and rolls back on throw, on both
   dialects.
2. Queries at arbitrary call depth inside the callback — including inside a
   service, and including nested relation reads from an `include` — run on the
   transaction. Assert by observing the connection, not by inference.
3. Nested transactions behave as savepoints; inner rollback leaves the outer
   transaction usable.
4. Two concurrent transactions are isolated from each other.
5. `DB.transaction` still works, and ORM calls inside it join the transaction.
6. ORM calls made *outside* any transaction use the pooled connection.
7. Plan cache is unaffected by transaction state.
8. The single-ALS deviation is documented in `packages/gemi/kernel/context.ts`
   and approved.
9. `bun run lint` and `bun run test` pass.

## Out of scope

Isolation-level configuration, retry-on-serialization-failure, distributed or
two-phase transactions, a unit-of-work / deferred-flush model (iteration 8
territory, and only if the Eloquent tier is pursued).

## Notes and risks

- **Long-lived transactions hold a pooled connection.** Nothing here prevents a
  callback from doing network I/O while holding one. A development-mode warning
  above a duration threshold is cheap and worth considering, though not required.
- **ALS has a real cost** under heavy concurrency. It is already used per request
  by the kernel, so the marginal cost of a second, shallower store should be
  small — but iteration 7 should measure it rather than assume, since this is on
  the hot path of every query.
- **Bun's `sql.begin` semantics** — reentrancy, whether the handle is usable after
  resolve, savepoint naming — should be verified with a small spike before the
  implementation is built on top of them.
