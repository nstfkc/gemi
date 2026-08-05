# Rows and entities

Queries return **plain objects**. That is the default, it is not a stepping stone, and most
applications should never need anything else.

Beyond it there are two further levels, both opt-in. They exist because "mutate an object and
save it" is genuinely convenient and "call a method on a record" sometimes is too — but each one
buys that convenience with something, and the price is worth knowing before you pay it.

These are **three deliberate levels, not one unfinished abstraction.**

| Level | What you get | What it costs |
| --- | --- | --- |
| POJOs *(default)* | Plain objects, full `select` narrowing | Nothing |
| `track` + `save` | Mutate and persist, only changed columns | ~2× read time when on; provenance tied to object identity |
| `wrap` | Methods on a record | Requires a complete row |

## Level 1 — plain objects

```ts
const users = await User.findMany({ where: { organizationId }, select: { id: true, email: true } })
users[0].email
```

Exactly what Prisma returns, including `select` and `include` narrowing the type. Nothing is
hydrated, nothing is proxied, and `users[0]` is a plain object you can spread, serialise, or
hand to a view without thinking about it.

This is the level `select` works properly at, and that is the reason it is the default: a
narrowed row is a narrowed *type*, so there is nothing on it that could read a field the query
did not fetch.

## Level 2 — `track` and `save`

To mutate a row and persist it, ask for provenance when you read it:

```ts
const user = await User.findUnique({ where: { id } }, { track: true })
user.name = "New name"
await User.save(user)      // update "User" set "name" = ?, "updatedAt" = ? where "id" = ?
```

`save` diffs against the values that came back and writes **only what changed**. An unchanged
row is a no-op: no statement, and no `@updatedAt` stamp.

`track` is a **second argument**, not a key inside the query, so `Prisma.UserFindManyArgs` keeps
describing exactly what the operation accepts.

### It is off by default, and that is a measurement

Provenance costs a `WeakMap` insert and a snapshot clone per row. On a 1 000-row read that is
**about +100% on SQLite** — see `plans/orm/benchmarks.md`, which has no Postgres measurement to
set beside it. So it is not a flag to set out of habit; on a large read it is a real decision.

### Provenance is tied to object identity

This is the first thing you will hit, so it is worth reading before you hit it.

```ts
const user = await User.findUnique({ where: { id } }, { track: true })
const copy = { ...user }
await User.save(copy)     // throws: this object carries no provenance
```

Provenance lives in a `WeakMap` keyed on the object, which is what stops it leaking — the entry
goes when the row does. The consequence is that any *copy* is a different object with none:
spreading, cloning, `structuredClone`, or a JSON round trip through a queue or an HTTP boundary
all lose it.

`save` raises there rather than guessing. The guess would be "write every column", and writing a
column that was never fetched is how a partial `select` silently reverts data.

### A partial row can be saved — and assigning to an unfetched column is refused

```ts
const user = await User.findUnique({ where: { id }, select: { id: true, name: true } }, { track: true })
user.name = "Renamed"
await User.save(user)             // update "User" set "name" = ? …
```

A partial row saves the columns it read. It cannot write the ones it did not, because there is
nothing to compare them against and writing them blind would overwrite whatever the column
actually holds.

Assigning to one is an **error**, not a silent no-op:

```ts
user.email = "nope@example.com"   // never fetched
await User.save(user)             // ✗ 'email' was not fetched by the query this row came from
```

Two ways forward, and the error names both: select the column, or update it explicitly with
`User.update({ where, data: { email } })`.

The row must also carry its **primary key** — a `select` without it leaves nothing to identify
which row to update, and `save` says so rather than failing further down with a confusing
`where` error.

### The row is refreshed after a save

`save` copies the database's version of the row back over yours, so `user.updatedAt` is the
instant the update happened rather than the one you fetched. Anything else the database rewrote
comes back too.

### It saves back to the connection the row came from

If you read the row on a [named connection](./orm.md#connections), `save` writes it there:

```ts
const [row] = await User.on("analytics").findMany({}, { track: true })
row.name = "changed"
await User.save(row)                    // updates "analytics", with nothing said here
```

This is the one place a connection is not resolved from the surrounding scope, and it is why the
connection is part of provenance alongside the model and the primary key. A tracked row is an
ordinary object: it outlives the query that produced it, so by the time it is saved — three
functions later, from code that never mentioned a connection — there is no scope left to read.
Resolved the other way, `save` would compile a correct `update` and send it to the default
connection, where the same id usually names a real and different row.

Naming a *different* connection is a contradiction rather than an instruction and raises:
`User.on("default").save(rowFromAnalytics)`. Copying a row between connections is a write in its
own right — say it with `update`, where the `where` and the `data` are both visible.

`wrap` carries the connection across too, so `User.wrap(row).save()` goes where `row` came from.

### Everything else still applies

`save` compiles through the same path as any other write, so [policies](./orm.md#policies)
scope it, `@updatedAt` stamps it, an open transaction contains it, and two saves touching the
same columns share one cached plan. Inside a transaction on *another* connection it raises
`CrossConnectionTransactionError` instead: that update cannot join the transaction, so it must not
run at all.

## Level 3 — `wrap`, for behaviour

When a record genuinely wants methods:

```ts
export class User extends UserModel {
  get displayName() {
    return this.name ?? this.email ?? "anonymous"
  }
}

const user = User.wrap(await User.findUniqueOrThrow({ where: { id } }))
user.displayName
await user.save()
```

`wrap` requires a **complete** row. A partial one is a compile error:

```ts
const partial = await User.findUnique({ where: { id }, select: { id: true } })
User.wrap(partial)   // ✗ Type error: missing properties
```

That single constraint is what lets instances and `select` coexist. `displayName` reads
`this.email`, so it is only safe if `email` was fetched — and the type system, not a runtime
check, is what guarantees it. Narrowing and behaviour never meet.

It is also why `wrap` needs no `track`: a complete row is one that can be snapshotted in full,
so the instance is tracked and `save()` works on it. The type constraint and the save capability
are the same constraint.

### `wrap` is explicit on purpose

Queries do not hydrate by default and will not. The moment they did, `select: { id: true }`
would produce an instance whose methods can read fields the query never fetched — a runtime
crash the type system cannot see, because the operation's return type still describes a narrowed
payload.

There is an `ActiveRecordModel` base in the ORM that makes every query return instances by
overriding one method. It ships as a **documented example rather than a supported tier**, for
exactly the reason above plus one more: the return *types* do not change, so the methods are
invisible to TypeScript at the call site even though they exist at runtime. Fixing that means
conditional return types across every operation, which is the complexity the plain-object
default was chosen to avoid.

Use it if you want to see the seam work. Reach for `wrap` if you want the guarantee.

## What this is not

There is **no identity map, no unit of work, no deferred flush, and no lazy relation loading on
instances** — deliberately, and not as a gap to be filled later without a plan.

Full Doctrine- or Hibernate-style active record brings flush ordering across foreign keys,
cascade semantics, stale-instance invalidation, and a request-scoped identity map that is a
memory leak if scoped too widely and a cross-tenant data leak if scoped wrongly. **Half an
identity map is worse than none**, because code starts relying on guarantees it only sometimes
has.

So: two objects read from the same row in the same request are two objects, and mutating one does
not change the other. `save` writes when you call it and not before. If you need a transaction
around several saves, open one:

```ts
await Model.transaction(async () => {
  await User.save(user)
  await Account.save(account)
})
```

If this tier is ever pursued properly it gets its own plan and its own decision about whether
the ORM is the product rather than one part of the framework. Until then, the levels above are
what there is, and they are complete as described.
