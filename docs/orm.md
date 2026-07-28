# ORM

gemi's ORM keeps Prisma's developer experience — including full `select` / `include` type
narrowing — while executing every query itself through Bun's native `SQL` client. There is no
Prisma query engine at runtime, no serialization boundary, and no Prisma client in your bundle.

Two things justify it, and both are things Prisma structurally cannot give you:

- **Ambient transactions.** `Model.transaction(fn)` puts every query inside `fn` — including
  queries in code `fn` calls, three layers down, that knows nothing about transactions — on one
  connection inside one transaction. No `tx` parameter threaded through your call stack.
- **First-class policies that apply to nested reads.** A tenant scope on `Account` applies to
  `Account.findMany()` *and* to the `accounts` inside `User.findMany({ include: { accounts: true } })`.

## Division of labour

Prisma is still here. It owns everything about your schema; gemi owns everything about running
queries against it.

| Concern | Owner |
| --- | --- |
| Schema definition (`schema.prisma`) | Prisma |
| Migrations (`prisma migrate`) | Prisma |
| Query argument and result **types** | Prisma (`prisma generate`, imported type-only) |
| Runtime model metadata | gemi (a Prisma generator block, run by `prisma generate`) |
| SQL compilation, execution, result shaping | gemi |
| Transactions, policies, hooks | gemi |

`@prisma/client` is generated and imported **type-only**. It never appears in a runtime import
and never ships in a bundle.

## Setup

Add the gemi generator to `schema.prisma`, *after* the `client` block — the emitted bases
type-import `@prisma/client`, and Prisma runs generators in declaration order.

```prisma
generator client {
  provider = "prisma-client-js"
}

generator gemi {
  provider = "gemi-orm-generator"
  output   = "../app/models/generated"
}
```

Then `bunx prisma generate`. You get three files under `app/models/generated/`:

- `schema.ts` — runtime metadata: tables, columns, types, defaults, relations.
- `models.ts` — a typed base class per model, carrying the thirteen operations.
- `index.ts` — registers every model by name.

**The output is committed on purpose.** Diffs stay reviewable and CI needs no codegen step.

### Your model class

The generated base is not the class you write code on. Subclass it, and **re-register it**:

```ts
// app/models/User.ts
import { register } from "gemi/orm"
import { UserModel } from "./generated"

export class User extends UserModel {}

register("User", User)
```

That `register` line is not bookkeeping. A relation read resolves its target through the registry
by name, so whatever is registered under `"User"` is the class that runs inside every nested
`include`. If that is the generated base while your policy lives on your subclass, the policy
applies to root queries and is skipped inside includes — scoped one way, unscoped the other, with
nothing to notice it. `Model.$exec` raises `UnregisteredPolicyClassError` when a class carrying
policies is queried while a *different* class owns its name — but that guard is narrower than it
sounds, and the gap runs the wrong way. **A model you only ever read through an `include` never
trips it:** the include resolves the name to the unpolicied generated base, nothing diverges from
nothing, and the rows come back unscoped with no error. That is the shape a membership or pivot
model usually has, and it is exactly the kind that carries a tenant scope. Write the line next to
every subclass regardless — the guard is a backstop for the cases it can see, not a substitute.

For the case it cannot see, there is an audit you can run once instead of trusting thirteen
subclasses:

```ts
import { assertPoliciesRegistered } from "gemi/orm"
import * as generated from "@/app/models/generated"
import * as models from "@/app/models/User"

assertPoliciesRegistered(generated, models)
```

Same rule, triggered differently: it reads the classes out of the module namespace, so a policied
class that nothing queries is still visible. In a test it closes the hole for CI at no runtime cost;
at boot it turns a deploy of the mistake into a failure to start rather than a quiet cross-tenant
read. It can only see modules you hand it, so it does not replace the `register` line either.

## Querying

Thirteen operations, with Prisma's argument types verbatim:

```
findMany   findFirst   findFirstOrThrow   findUnique   findUniqueOrThrow   count
create     createMany  update             updateMany   upsert              delete   deleteMany
```

```ts
const users = await User.findMany({
  where: { organizationId, email: { contains: "@example.com" } },
  orderBy: { createdAt: "desc" },
  take: 20,
})

const user = await User.findUniqueOrThrow({
  where: { id },
  select: { id: true, email: true, accounts: { select: { provider: true } } },
})
```

`select` and `include` narrow the **return type**, exactly as they do in Prisma — `user.email`
type-checks, `user.name` does not. A key outside the operation's argument type collapses to
`never` rather than being quietly accepted.

Queries return **plain objects**, never class instances. That is the default and it is not a
stepping stone: a `Pick<User, "id">` hydrated as a `User` would carry methods reading fields the
query never fetched. See [Rows and entities](./orm-rows-and-entities.md) for the two opt-in levels
above it — `track` + `save`, and `wrap`.

### Per-call options

A second parameter, not a key inside `args` — intersecting Prisma's own arg types with a
gemi-specific key would mean `Prisma.UserFindManyArgs` no longer describes what the operation
accepts.

```ts
await User.findMany({ where }, { track: true, strategy: "batched" })
```

| Option | What it does |
| --- | --- |
| `track` | Record where each row came from so `Model.save(row)` can update it. Off by default; it costs a `WeakMap` insert and a snapshot clone per row. |
| `strategy` | Which relation strategy loads the `include` tree. See below. |

## Relations

`include` and nested `select` work at any depth up to `MAX_RELATION_DEPTH` (10). Two strategies load
them, and they return identical rows:

- **`batched`** — one query per include node, with the children stitched onto the parents in
  process. Works on every dialect.
- **`lateral`** — the children folded into the root statement with a `LATERAL` join and
  `json_agg`. **Postgres only, and the default there.** One round trip instead of one per node.

The lateral strategy **declines per node** rather than emitting SQL it cannot get right, falling
back to batching for that node alone. It declines a node that has its own `include`, a relation
inside a `select`, and an implicit many-to-many. A mixed include tree therefore uses both, which
is fine — the results are the same either way, and there are tests asserting exactly that against
Prisma across thirty relation shapes.

Override per call when you need to:

```ts
await User.findMany({ include: { accounts: true } }, { strategy: "batched" })
```

Unlike `track`, `strategy` **does** reach the compiler and **is** part of the plan cache key: two
strategies emit different SQL for the same arguments.

### Filtering on a relation

```ts
await User.findMany({ where: { accounts: { some: { role: "owner" } } } })
await User.findMany({ where: { organization: { name: "acme" } } })
await User.findMany({ where: { organization: null } })          // has none
```

`some` / `every` / `none` on a to-many, `is` / `isNot` (or the object directly) on a to-one. Each
compiles to a correlated `exists` subquery, so a filter only ever *removes* parent rows — a join
would multiply them and then need a `distinct` to put them back.

Two of these read less obviously than they look:

- **`every` includes parents with no children at all.** It means "no child fails this", not "some
  child passes this", which is the vacuous-truth reading Prisma has.
- **`isNot` matches rows with no related record**, as well as rows whose related record does not
  match.

**The child's policies apply**, the same as they do inside an `include` — the subquery is scoped
before it is compiled. Worth stating because the leak here is quieter than an unscoped `include`:
`where: { memberships: { some: {} } }` returns no membership rows at all, so an unscoped version
would leak *existence* — which users have a membership in a tenant you cannot see.

### Counting a relation

```ts
const users = await User.findMany({
  include: { _count: { select: { accounts: true } } },
})
users[0]._count.accounts        // 3

// counting a subset
include: { _count: { select: { accounts: { where: { role: "owner" } } } } }
```

A correlated `count(*)` in the same statement — no second round trip, and no change to the row
set. The counted relation's policies scope it, so a count only ever counts rows you could have
read. That matters more than it looks: an unscoped count returns a *number*, so what it would leak
is how many rows exist in tenants you cannot see.

**Index the child's foreign key.** A correlated subquery runs once per parent row, so without an
index each run scans the child table — and Prisma declares no index for a relation's foreign key
on either dialect, so by default there is none:

```prisma
model Account {
  userId Int?
  user   User? @relation(fields: [userId], references: [id])

  @@index([userId])
}
```

Measured on 100 parents, that one line is worth **6.3×** on `_count` and **4.0×** on an `exists`
filter on SQLite. It flips the advice, too: unindexed, `_count` is 2.4× *slower* than loading the
children and counting them in JavaScript; indexed, it is 2.6× faster. The same applies to relation
filters, which are the same shape. Numbers and method in `plans/orm/benchmarks.md`.

`_count: true` (Prisma's "count every to-many relation") is **not** implemented. Name the relations
instead — the shorthand names none, so a policy has nowhere to attach, and what it returns changes
silently when the schema grows a relation.

### Ordering by a relation

```ts
await User.findMany({ orderBy: { organization: { name: "asc" } } })   // to-one: a field
await User.findMany({ orderBy: { accounts: { _count: "desc" } } })    // to-many: the count
```

A to-one orders by one of the related row's fields; a to-many orders by `_count`, because
"order by the child's name" has no single answer for a parent with several children. Both compile
to a correlated subquery, so the same index advice applies — and a parent with no related row (or
none you can read) sorts as `NULL`.

Ordering by a relation is not a total order, so add a tiebreak if you need a stable page:
`orderBy: [{ accounts: { _count: "desc" } }, { id: "asc" }]`.

**Not implemented yet:** counting, filtering or ordering across an implicit many-to-many, and
`_count` on a to-one (which can only ever be 0 or 1 — its nullability already says which). All
raise `UnsupportedQueryError` rather than being silently ignored.

### One value that will surprise you

A `Bytes` column comes back as a plain `Uint8Array`, on every dialect and under either strategy —
which is what Prisma returns, so it is parity rather than a gemi choice. The surprise is that
`Uint8Array.prototype.toString` **ignores its argument**:

```ts
row.blob.toString("hex")                 // "1,2,255" — not an error, just wrong
Buffer.from(row.blob).toString("hex")    // "0102ff"
```

Worth knowing because the wrong form looks right and throws nothing. It is also the reason the
container is asserted rather than only the contents in the coercion tests: `Buffer` is a
`Uint8Array` subclass, so the two compare equal element by element while behaving differently here.
Postgres' driver hands back a `Buffer` and the dialect normalises it, so this stays one answer
across dialects.

## Transactions

```ts
await User.transaction(async () => {
  const user = await User.create({ data: { email } })
  await audit(user)          // its queries are in the transaction too
})
```

`audit` needs no transaction parameter and no awareness that one is open. The scope is carried in
an `AsyncLocalStorage`, so every ORM query in the async subtree joins it. Commit on return,
rollback on throw.

Nesting is a **savepoint**: an inner failure rolls back to the savepoint and leaves the outer
transaction usable.

### Two things that will bite you

**Catching an error inside a transaction, on Postgres.** Any failed statement aborts the whole
Postgres transaction block, so catching it and carrying on loses everything. SQLite does not care
— which means this is a bug that passes in development and takes out the transaction in
production:

```ts
await Model.transaction(async () => {
  try { await User.create({ data: { email } }) }
  catch (e) { if (!(e instanceof UniqueConstraintError)) throw e }
  await Audit.create({ … })   // fine on SQLite; on Postgres: "current transaction is aborted"
})
```

The fix is to make the fallible statement its own savepoint, which works on both dialects:

```ts
await Model.transaction(async () => {
  try {
    await Model.transaction(() => User.create({ data: { email } }))
  } catch (e) { if (!(e instanceof UniqueConstraintError)) throw e }
  await Audit.create({ … })   // fine on both
})
```

**One statement at a time.** Every query in scope runs on one reserved connection, so
`Promise.all` over several ORM calls inside the callback is not safe — the ordinary, encouraged
thing everywhere else in a Bun codebase. Await them in sequence.

## Policies

A policy is a plain object on the model class. Every member is optional; a model with none pays a
single `undefined` check per query.

```ts
export class Account extends AccountModel {
  static $policy = {
    scope: (ctx) => ({ organizationId: ctx.user.organizationId }),
    onCreate: (ctx, data) => ({ ...data, organizationId: ctx.user.organizationId }),
  }
}

register("Account", Account)
```

| Member | When it runs | What it does |
| --- | --- | --- |
| `before(ctx)` | First | Return `false` (or throw) to deny outright. |
| `scope(ctx)` | Reads and row-matching writes | Returns a `where` fragment `AND`ed into `args.where`. A policy can only ever **narrow**. |
| `onCreate(ctx, data)` | `create` / `createMany` / `upsert` | Defaults or validates the payload. An insert has no `where` for a scope to narrow. |
| `redact(ctx, row)` | Shaping | Removes fields from a fetched row. |

**Policies rewrite the argument tree, never SQL.** That is what makes a scope two lines instead of
string surgery, what keeps the two relation strategies interchangeable, and what keeps the plan
cache sound — policies run *before* the plan key is computed, so two differently-scoped users
never share a plan.

Because the rewrite happens on the arg tree, a nested read is scoped too:

```ts
await User.findMany({ include: { accounts: true } })
// the accounts subquery carries Account's scope, under either strategy
```

### `ctx.user` denies by default

Reading `ctx.user` when there is no user raises `PolicyDeniedError`. Not returning `null` —
raising. A scope built from a null user would be `{ organizationId: undefined }`, and an undefined
value is an *absent* filter, so the scope would silently vanish and the read would be unscoped.
The leak is the quiet version of this error.

Check `ctx.hasUser` first if a policy genuinely wants to handle both cases.

The user is read **synchronously** off the request store, because this hook runs once per query
per node of an include tree and an awaited user would be a round trip per node. The consequence:
**a route without the `auth` middleware sees no user even when the request carries a valid
cookie.** That is the correct reading — the route did not ask to authenticate — but it makes
middleware configuration load-bearing for data access.

### Outside a request

Cron ticks, queue workers, seed scripts and tests never enter a request scope, so there is no
ambient user. Two escapes:

```ts
await Model.asSystem(async () => { … })   // no actor; ctx.user reads null instead of raising
await Model.asUser(actor, async () => { … })  // act as a specific user
```

`asSystem` is what the framework's own auth adapter uses: authentication runs *before* there is an
authenticated user, so a policy scoping by `ctx.user` could not be satisfied and deny-by-default
would turn "wrong password" into a 500.

### A `scope` with no `onCreate` is refused

If a policy scopes reads but says nothing about creates, `create` raises rather than writing a row
into whatever tenant the caller named. Add an `onCreate` that sets the scoped column — or, if
unscoped creates really are intended, say so with a pass-through `onCreate`.

### Soft deletes

Ships as a policy, which is the proof the hook is expressive enough to be worth having:

```ts
import { softDelete, softDeleteMany, softDeletes } from "gemi/orm"

export class User extends UserModel {
  static $policy = softDeletes()          // reads skip rows with a deletedAt
  static delete = softDelete(User)        // delete becomes an update
  static deleteMany = softDeleteMany(User)
}
```

`deletedAt` must be a nullable `DateTime` on the model (`field` overrides the column name). The
read half applies to nested reads for the same reason every policy does — a deleted `Account` does
not appear under `User.findMany({ include: { accounts: true } })` without anything being written at
the include site, which is the half ORM-level soft deletes usually get wrong.

A class has one `$policy`, so composing with your own means composing the objects. The base-class
route is usually cleaner and gets the ordering right for free (`policiesFor` walks base to
derived, so the soft-delete scope applies first and yours narrows further):

```ts
class SoftDeleted extends UserModel { static $policy = softDeletes() }
export class User extends SoftDeleted { static $policy = { …mine } }
```

## Errors

Every failure is a typed error from `gemi/orm`, not a driver string.

| Error | Raised when |
| --- | --- |
| `RecordNotFoundError` | An `…OrThrow` operation matched nothing. |
| `UniqueConstraintError` | A unique constraint was violated, with the constraint identified. |
| `PolicyDeniedError` | A `before` denied, or `ctx.user` was read with no user. |
| `UnknownFieldError` / `UnknownRelationError` | A name that is not on the model. |
| `UnsupportedQueryError` | A query shape the compiler does not implement — with what and why. |
| `ModelNotRegisteredError` / `UnregisteredPolicyClassError` | Registry problems (see [Setup](#your-model-class)). |
| `RelationDepthExceededError` | An include tree past `MAX_RELATION_DEPTH`. |
| `ParameterLimitError` | A statement exceeding the dialect's parameter ceiling. |
| `StaleSchemaArtifactError` | Generated files predate the running gemi. Re-run `prisma generate`. |

## Performance

**Compilation is split from binding.** `compile` is a pure function of the argument *shape* and
produces SQL where every value is a placeholder (`?` on SQLite, `$1` on Postgres); `bind` is the
only stage that sees a value.
So the same query shape produces byte-identical SQL, which makes it cacheable — and it makes SQL
injection structurally impossible rather than carefully avoided, since identifiers can only come
from the generated schema and values can only ever be parameters.

Compiled plans are cached on `dialect:strategy:model:operation:canonicalShape`, in an LRU bounded
at 1000 entries. `planCacheStats()` reports `size`, `compiles`, `hits`, `evictions` and
`capacity`; `clearPlanCache()` empties it, which tests want and applications should not need.

Measured numbers, the methodology, and the reasoning behind the lateral default live in
`plans/orm/benchmarks.md` in the repository — deliberately not here, because they are tied to a
machine and a dataset and would go stale as documentation.

## Dialects

**SQLite and Postgres** are built and tested, on every operation, against a differential harness
that runs each query through both gemi and Prisma and compares the rows. `DatabaseManager` infers
the dialect from `DATABASE_URL`.

MySQL and MariaDB are **not** implemented. The dialect seam is there and `DatabaseManager` already
recognises them, but nothing is built or tested behind it.

## Not in scope

Stated so you can plan around them rather than discover them:

- **No identity map and no unit of work.** Two queries for the same row give you two objects. Half
  an identity map is worse than none.
- **No lazy loading.** A relation you did not `include` is absent, not a proxy that queries when
  touched.
- **No `omit`.** Use `select`, or a policy's `redact`.
- **No migrations, no schema DSL.** Prisma owns both, and gemi must not shadow the Prisma CLI.

## See also

- **[Rows and entities](./orm-rows-and-entities.md)** — POJOs, `track` + `save`, and `wrap`.
- **[Authentication](./authentication.md)** — `app/config/auth.ts` and the user provider seam.
  `OrmAuthenticationAdapter` (exported from `gemi/kernel`, beside the Prisma one) implements all
  twenty-two methods of `IAuthenticationAdapter` on this ORM and can be selected in its place. The
  starter template still points at the Prisma adapter; switching it is a per-application call.
- **[Authorization](./authorization.md)** — route-level authorization, which policies complement
  rather than replace.
