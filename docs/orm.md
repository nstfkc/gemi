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
- `models.ts` — a typed base class per model, carrying the fourteen operations.
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

Fourteen operations, with Prisma's argument types verbatim:

```
findMany   findFirst   findFirstOrThrow   findUnique   findUniqueOrThrow   count   aggregate   groupBy
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

A write's `include` takes `_count` as a read's does — `User.create({ data, include: { _count: {
select: { accounts: true } } } })` comes back with `_count.accounts`. It compiles to a correlated
subquery inside the `RETURNING`, so it costs no extra statement. Two orderings are handled so the
number agrees with the row beside it: a `delete` carrying one reads the count *before* the row
goes, and a write whose nested `create` writes children *after* the statement recomputes it once
they have — otherwise `include` and `_count` would describe the same relation and disagree.

**`take` and `skip` must be integers, and are refused rather than coerced.** They are the only
arguments whose *sign* decides the SQL — a negative `take` means "the last N", which flips every
ordering term — so a `take` arriving as a string does not merely have the wrong type, it takes the
wrong branch: `take: "-2"` used to return the **first** two rows, in the opposite order, with no
error. A query string is exactly where a string `take` comes from, so parse it before you pass it:

```
UnsupportedQueryError: gemi ORM does not support 'take' yet (User.findMany).
Expected an integer, got "-2".
```

A negative `skip` is refused too — it counts rows to pass over — and both rules are the ones that
already applied inside an `include`.

> **Divergence from Prisma, on purpose.** Prisma accepts a *fractional* `take` and truncates toward
> zero; this refuses it. Binding one instead is a `datatype mismatch` error from SQLite and a
> silently different row count on Postgres, which rounds — so the fraction has no single meaning to
> match. One rule at both levels, failing loudly, beats three behaviours.

`select` and `include` narrow the **return type**, exactly as they do in Prisma — `user.email`
type-checks, `user.name` does not. A key outside the operation's argument type collapses to
`never` rather than being quietly accepted.

**Foreign keys are enforced on both dialects.** SQLite leaves `pragma foreign_keys` off by
default and so does Bun's driver, so gemi turns it on for every SQLite connection — otherwise a
`references` in your migration would mean nothing there while meaning everything on Postgres. An
insert naming a parent that does not exist is refused, and `onDelete: Cascade` / `SetNull` actually
run. If you have been developing against SQLite, writes that quietly succeeded may now raise; they
were already raising in production.

Queries return **plain objects**, never class instances. That is the default and it is not a
stepping stone: a `Pick<User, "id">` hydrated as a `User` would carry methods reading fields the
query never fetched. See [Rows and entities](./orm-rows-and-entities.md) for the two opt-in levels
above it — `track` + `save`, and `wrap`.

### Aggregates

```ts
const { _max } = await Post.aggregate({
  where: { boardId },
  _max: { position: true },
})
const next = (_max.position ?? 0) + 1
```

That is the shape most reaches for `aggregate`: the next sort index when reordering a list, not
analytics. All five of Prisma's functions are here, and they compose into one statement:

```ts
await User.aggregate({
  where: { globalRole: { gt: 0 } },
  _count: { _all: true, email: true },
  _sum: { globalRole: true },
  _avg: { globalRole: true },
  _min: { createdAt: true },
  _max: { createdAt: true },
})
```

Three behaviours are Prisma's and are easy to get wrong in the other direction:

- **`_count` has two shapes.** `_count: true` returns a number; `_count: { _all: true, email: true }`
  returns an object — and a **per-field count counts rows where that column is not null**, which is
  a different number from `_all` and the reason to ask per field.
- **The empty set is not zeroes.** Over no matching rows `_count` is `0`, but `_sum`, `_avg`, `_min`
  and `_max` are each `null`, per field.
- **`take` / `skip` page the rows being aggregated**, not the one row that comes back — so
  `take: 2` with `orderBy: { position: "asc" }` sums the first two rows, not the whole table.
  (`orderBy` on its own, with no pagination, changes nothing and is dropped.)

`count` gains Prisma's per-field form for the same reason:

```ts
await User.count()                                   // 3
await User.count({ select: { _all: true, email: true } })  // { _all: 3, email: 2 }
```

Results are typed by Prisma's own mapped types, so `_max: { position: true }` narrows to
`{ _max: { position: number | null } }` and nothing else.

### `groupBy`

```ts
const perOperation = await Usage.groupBy({
  by: ["operation"],                       // or "operation" — Prisma takes both
  where: { occurredAt: { gte: since } },
  _sum: { credits: true },
  _count: true,
  having: { credits: { _sum: { gt: 0 } } },
  orderBy: { _count: { operation: "desc" } },
})
// [{ operation: "render", _count: 42, _sum: { credits: 1200 } }, …]
```

The grouped columns come back flat and the aggregates nested under their kind, which is Prisma's
shape. Four rules are worth knowing because they are not what the arguments suggest:

- **`orderBy` may only name grouped columns — or an aggregate.** A group has one value for a column
  in `by` and many for everything else, so ordering by anything else is a question with no answer.
  SQLite answers it anyway, by picking an arbitrary row's value, so this is refused rather than
  passed through. `orderBy: { _count: { field: "desc" } }` is the top-N-by-count query and is fine.
- **`orderBy` is optional.** `groupBy` with none is a legal query.
- **`having` filters groups, `where` filters rows.** `having: { role: { gt: 0 } }` needs `role` to be
  in `by`; `having: { email: { _count: { gt: 1 } } }` does not, because a count has one value per
  group either way. That split is Prisma's, and it is easy to read as stricter than it is.
- **`take` / `skip` page the groups**, not the rows — unlike `aggregate`, where they page the rows
  being aggregated.

One divergence, and it is a refusal rather than a difference: `having: { role: { gt: 0, _count: { gt: 1 } } }`
mixes a column comparison and an aggregate filter under one key. Prisma's query engine panics on that
shape rather than answering it, so there is no behaviour to match — spell it as an `AND` of the two.

### Looking a row up by a composite key

`findUnique`, `update`, `delete` and `upsert` need a key that is unique. A composite one — whether
it is a compound `@@id([a, b])` or an `@@unique([a, b])` — is named in Prisma's compound form:

```ts
await Membership.findUnique({
  where: { organizationId_userId: { organizationId, userId } },
})
```

Every member is required. A composite key is only unique as a whole, so a partial one would quietly
become a non-unique lookup — which is the failure `findUnique` exists to prevent, and it is refused
by name.

### Returning everything except one column

```ts
const user = await User.findUnique({ where: { id }, omit: { password: true } })
```

`omit` is the complement of `select`, and the reason to have both is what happens when the model
gains a column. With `select` the exclusion list has to be rewritten every time, and the day
somebody forgets is the day the new column silently stops being returned. `omit` says the thing that
is actually stable about the query — *this column must never leave the process* — so a column added
later is included by default.

It is a real projection: the omitted column never enters the `SELECT` list, so it is not read, not
shaped and not decoded. `select` and `omit` together are refused, because one names what to keep and
the other what to drop; Prisma rejects that pair too. It works on every operation that returns a
payload, reads and writes alike, and **inside an `include`** — which is where it usually matters,
since a column you never want to leave the process is as likely to be on a related row as on the
root one. Both relation strategies honour it.

**It is not a substitute for a policy's `redact`.** `omit` is the caller choosing; `redact` is the
model refusing, and a caller cannot opt out of it. Use `redact` for "nobody may read this", and
`omit` for "I do not need this here".

### Importing a batch that may overlap

```ts
await Product.createMany({ data: rows, skipDuplicates: true })   // Postgres only
```

`ON CONFLICT DO NOTHING`, untargeted — so it covers every unique constraint and the primary key at
once, which is what `skipDuplicates` means. The returned `{ count }` is the number of rows
**inserted**, not the number supplied, so it answers "how many were new".

The check and the insert being one statement is the whole point. Reading first to find out which
rows exist is a second query *and* a race: between the read and the insert a concurrent importer
writes one of them, and the insert fails on a unique violation anyway.

**Postgres only, and that is Prisma's line rather than SQL's.** SQLite can express the same clause;
Prisma rejects the argument there — for `false` as well as `true` — so gemi does too, rather than
becoming a silent superset on the one dialect the differential harness could then no longer compare.
On SQLite the error names the dialect and says so. If a batch is too large for one statement it is
split inside a transaction, and `skipDuplicates` survives the split: the counts sum, and a conflict
in a later chunk does not roll back an earlier one, because `do nothing` is not an error.

### What a refusal tells you

Three classes, and which one you get says what to do next:

| Error | Means | Do |
| --- | --- | --- |
| `UnsupportedQueryError` | not implemented **yet** | wait for a release, or use what the message names |
| `UnsupportedByDesignError` | decided against | change the call — the message says to what |
| `InvalidArgumentError` | the argument exists, the value cannot mean anything | fix the value |

The third is the one worth knowing about. `take: "-2"` used to report that the ORM "does not support
`take` yet" — wrong on both halves: it does, and there is nothing to wait for. It now says
`Invalid 'take' (User.findMany). Expected an integer, got "-2".`

All three subclass `UnsupportedQueryError`, so `catch (e) { if (e instanceof UnsupportedQueryError) }`
still catches every one. The specific classes are for the person reading the message.

One edge is deliberate: an argument that is not in the grammar **at all** — a typo — keeps
`UnsupportedQueryError` and its "yet", because the same check also refuses real Prisma arguments this
ORM has not implemented, and nothing there can tell the two apart. The sentence immediately after it
lists what the operation *does* take, which is what tells you a typo is a typo.

Every refusal carries a second sentence saying what to do instead — that is a required argument
rather than a convention, so it cannot be dropped by a call site added later.

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
- **`lateral`** — the whole include tree folded into the root statement with `LATERAL` joins and
  `json_agg`. **Postgres only, and the default there.** One round trip for the tree instead of one
  per node.

The lateral strategy **declines per node** rather than emitting SQL it cannot get right, falling
back to batching for that node alone. It declines:

- an implicit many-to-many,
- a self-relation (a relation onto the same table),
- a node carrying a `_count`,
- a node ordered by a *relation* — `orderBy: { user: { email: "asc" } }` or
  `orderBy: { accounts: { _count: "desc" } }` — which compiles to a correlated subquery,
- and any node with one of those below it: half a fold is not a thing, so a descendant that cannot
  be expressed declines its whole node.

A declined node still runs under this strategy one level down, so a decline costs one statement, not
the subtree. A mixed include tree therefore uses both, which is fine — the results are the same
either way, and there are tests asserting exactly that against Prisma across thirty relation
shapes.

Override per call when you need to:

```ts
await User.findMany({ include: { accounts: true } }, { strategy: "batched" })
```

Unlike `track`, `strategy` **does** reach the compiler and **is** part of the plan cache key: two
strategies emit different SQL for the same arguments.

### Nested writes

A relation key inside `data` writes the far side in the same call:

```ts
await List.create({
  data: {
    name,
    organizationId,
    items: { createMany: { data: rows } },   // one statement for every row
  },
})
```

| Operand | What it does |
| --- | --- |
| `create` | Writes new related rows. One statement each. |
| `createMany` | The same rows in **one** statement. To-many only, and the rows go inside `data`. |
| `connect` | Points at an existing row — a bound column when it names the referenced key, a lookup otherwise. |
| `connectOrCreate` | Looks the row up by a unique key and creates it only if it is not there. **A hit ignores `create` entirely** — it is connect-*or*-create, not upsert. |
| `disconnect` | Clears the link. `true` on a to-one; a unique key, or a list of them, on a to-many. The column has to be nullable. |
| `delete` | Deletes the named rows outright, not just the link. |
| `update` | Writes your columns to the named row. The child's own `onUpdate` and scope rules apply to the payload. |
| `set` | Replaces the whole set — detaches what is linked now, attaches what you name. |
| `updateMany` | Writes your columns to this parent's rows matching a filter. |
| `deleteMany` | Deletes this parent's rows matching a filter — the filter goes directly under the key, not inside a `where`. |
| `upsert` | Finds the row **among this parent's**, updates it, or creates it. |

**A relation may join on more than one field.** `@relation(fields: [tenantId, orderId], references:
[tenantId, id])` is the tenant-scoped composite-key style, and every read surface handles it: an
`include` under either strategy, a relation filter, a `_count`, and an `orderBy` through the
relation. The correlation becomes one equality per field; the batched strategy filters its children
with an `OR` of `AND`s rather than a tuple `in`, because that is one shape both dialects already
compile.

Two consequences worth knowing. A composite join uses one placeholder *per field per parent*, so
SQLite's parameter ceiling arrives proportionally sooner on a wide `include` — `ParameterLimitError`
still names it rather than letting the driver fail. And a **nested write** through a composite
relation is refused: it would have to contribute that many foreign-key columns to the insert, which
is not implemented. Write the child separately with its keys set.

Which direction a nested write runs in is decided by **who holds the foreign key**. When this model
holds it, the far row is resolved or created *first* and collapses into one more column. When the
child holds it, nothing can be written until this row exists, so those run after — which is why the
statement returns the parent's key even when your `select` did not ask for it.

Three things follow from that, and all three are load-bearing:

- **The foreign key is ours to set, not yours.** A nested row that also named it would be describing
  a different parent than the call is, so it is overwritten.
- **The child's policies apply.** Each nested row goes through the related model's own `$exec`, so
  its `onCreate` stamps the tenant column and its `scope` decides which rows a `connect` can reach.
  A `createMany` writes its rows in one statement and they are *each* scoped.
  A relation operand writes one column — the relation's own key — and the
  scope-escape guard knows the ORM wrote it, so a child scoped on its foreign
  key can still be connected. A column *you* name in `data` is judged exactly as
  before.
- **A failure anywhere rolls the whole thing back**, including the parent row.

`connectOrCreate` is worth one more line, because a scoped-away row makes it take the *create*
branch rather than raise: a row your policies hide reads as absent, so the call writes its own — the
same answer you would get if it truly did not exist. That is deliberate. `connect` raising where
`connectOrCreate` succeeded would together tell you a row with that key exists in someone else's
tenant.

> **Known gap (#98).** A child whose policy *scopes on the foreign key itself* — `scope: () => ({
> folderId: mine })` — cannot use any relation operand that writes that key, including `connect`,
> unless it also declares an `onUpdate`. The scope-escape guard reads the payload and cannot tell a
> column you supplied from one the nested step put there. Pre-existing rather than new to
> `disconnect`, and tracked separately because the decision affects `connect` too.

`disconnect` and `delete` only exist on an `update` — a `create` has nothing linked to it yet, and
Prisma reports them as an unknown argument there too. They differ on a row that is **not** linked to
this parent, and the difference is Prisma's: `disconnect` succeeds and changes nothing, `delete`
raises. Both filter on the parent's key as well as yours, so neither can reach a row belonging to
somebody else — and a row your policies hide is not reachable either, which `delete` reports as "not
connected" rather than as denied, since that is the same answer a genuinely unlinked row gets.

`update` is where the two halves of the line meet: it names its row like `disconnect`, and it writes
your columns like a top-level `update` — so the payload goes through the child's own operation and
is judged by the child's policies. Naming a column the child scopes on is refused exactly as it
would be at the top level. On a to-one both spellings work, `update: { … }` and
`update: { data: { … } }`, because Prisma accepts both.

`set` is the one supported operand that acts on rows you did **not** name, so it means *replace the
set I can see*: it detaches the linked rows your policies let you read, and leaves the rest attached.
With no policy on the child that is Prisma's `set` exactly. Two of its behaviours are worth knowing
because the name does not suggest them — it will repoint a row belonging to another parent, exactly
as `connect` does, and it silently ignores a named row that does not exist.

`updateMany` and `deleteMany` take a **filter** rather than a key, and it applies to this parent's
rows only. Their operands are shaped differently and it is easy to get backwards: `updateMany` wraps
its filter in `where` and carries a `data` beside it, while `deleteMany` *is* the filter.

**An implicit many-to-many accepts a narrower set** — `connect`, `connectOrCreate`, `create`,
`disconnect` and `set`. The four that are missing (`update`, `updateMany`, `delete`, `deleteMany`)
reach the far row *through* the pairs, which that path does not do yet; Prisma implements all four,
so these are gaps rather than decisions and the refusals say so. `createMany` is the exception:
Prisma does not offer it through a join table either.

`upsert` looks for its row **among this parent's** rather than globally, which is Prisma's own
semantics and is the detail that decides what it does: naming a row that exists but belongs
elsewhere takes the *create* branch and collides on the unique key, rather than updating somebody
else's row.

Every operand in Prisma's nested grammar is now implemented for an ordinary relation. Ones that act
on rows already linked to this one — `disconnect`, `delete`, `update`, `updateMany`, `deleteMany`,
`set`, `upsert` — are available on an `update` and refused on a `create`, which has nothing linked
to it yet; Prisma reports them as unknown arguments there too.

Two rules hold across all of them. The **foreign key is the ORM's to set**, so a nested row naming
it is describing a different parent than the call is, and it is overwritten. And the **parent
restriction is conjoined, never merged** — a filter naming the foreign key column is narrowed by the
restriction rather than replacing it, so `deleteMany: { userId: <someone else> }` deletes nothing
rather than everything.

`skipDuplicates` is not implemented on `createMany` at any level.

### Paging a relation

```ts
await Store.findMany({
  include: {
    products: {
      orderBy: { position: "asc" },
      take: 10,                                       // ten products *per store*
      include: { media: { take: 1, orderBy: { position: "asc" } } },
    },
  },
})
```

`take` and `skip` inside a to-many are **per parent**, exactly as they are in Prisma — ten products
for each store, not ten in total. A negative `take` means "the last N" and comes back in the order
your `orderBy` describes, the same as at the root. Paginating without an `orderBy` orders by the
child's primary key, because "the first ten" is otherwise only meaningful if the scan happens to be
stable.

**This needs the `lateral` strategy, so it needs Postgres.** The batched strategy serves every
parent from one query, so the only `limit` it could emit would page every parent's children as a
single set — plausible, and wrong. It refuses instead:

```
UnsupportedQueryError: gemi ORM does not support 'products.take' yet (Store.findMany).
A 'take' inside a to-many relation is per parent, and the batched relation planner serves
every parent from one query — so the only limit it could emit would page every parent's
children as one set. Only the lateral join strategy can express it, by paginating inside a
subquery that already runs once per parent row, and it needs Postgres: this node declined to
fold (not postgres). Load 'products' as its own query, or narrow it with 'where'.
```

The tail of that message is the part to read: it says *why* this node reached a strategy that
cannot page it — the dialect, an explicit `strategy: "batched"`, or a decline. There is no
workaround that is both correct and affordable, which is why the refusal is loud: fetching every
child and slicing in JavaScript reads the whole table, and one query per parent is the N+1 the
`include` exists to avoid.

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

On SQLite that one line is worth several times the query — enough to *flip* the advice: unindexed,
`_count` is slower than loading the children and counting them in JavaScript; indexed, it is
comfortably faster. The same applies to relation filters and relation orderings, which are the same
shape.

Exact multipliers, the method, and what the measurement does **not** establish are in
`plans/orm/benchmarks.md`, which is generated. They are deliberately not repeated here: a number
copied into prose drifts from its source the first time the source is re-run, which happened three
times inside that report before its own sentences were derived rather than written.

The starter template indexes every foreign key for this reason, so a new application starts on the
right side of it.

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

Filtering, counting and ordering all work across an **implicit many-to-many** too — the join
table is a second table inside the subquery and changes nothing else about how you write the
query.

**Writing one works too**, through the same relation key inside `data`: `connect`, `disconnect`,
`set` and `create`. `set` replaces the whole set — a delete and then inserts, inside the same
transaction — and connecting a pair that is already there is a no-op rather than an error, as it is
in Prisma. An `update` whose `data` names only relations is fine: there is no column to set, so the
row is read rather than written and the relation work still happens.

Only the join table itself is written directly; it has no model and nothing an application could
scope. The rows the pairs point at still go through the related model's own operations, so a
`connect` cannot reach a row that model's policies hide, and a `create` gets its `onCreate`.

That extends to `set`, which has to delete before it inserts: it clears **the links you can see**,
not every link — in one `delete … in (…)`, not one statement per link. A pair pointing at a row the related model's policies hide survives — otherwise
`set` would quietly do what `disconnect` refuses. With no policy on that model every link is
visible and `set` clears all of them, exactly as Prisma does.

Self-referential ones work too — `Thing.related Thing[]` — as long as the generated files are
current. Prisma assigns that join table's two columns by *field name*, which the generator now
records; an artifact from before it does raises rather than guessing, and `prisma generate` fixes
it.

**Not implemented yet:** `_count` on a to-one, which can only ever be 0 or 1 — its nullability
already says which. It raises `UnsupportedQueryError` rather than being silently ignored.

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

**A multi-statement write is atomic on its own.** A write with a nested `create`, `createMany` or
`connect` runs more than one statement, and `$exec` opens a transaction for exactly those calls — so a nested
step that fails, or a child policy that denies, rolls back the parent row too. A plain `create`
still compiles to one statement and opens nothing, and inside a transaction you opened the nested
one becomes a savepoint. You do not need `Model.transaction` to make a single nested write whole;
you need it to make *several separate calls* whole.

### Keep slow work out of the callback

The reserved connection is held for as long as the callback runs, whether or not it is running
queries. A `fetch`, an upload or a queue push inside a transaction holds a connection for the
length of that I/O, and under load the symptom is unrelated queries elsewhere in the process
blocking on connection acquisition — an error that names neither the transaction nor the I/O.

In development, a transaction still open after 2 seconds warns with the stack of the call that
opened it:

```
[gemi] A database transaction has not settled after 2000ms. It reserves a pooled connection
until it does — check for network or filesystem I/O inside the callback…
```

The threshold is `slowTransactionThreshold` in `app/config/database.ts`:

```typescript
export default defineDatabaseConfig({
  url: process.env.DATABASE_URL,

  slowTransactionThreshold: 5_000,   // milliseconds, or `false` to switch it off
});
```

`false` is the only way to disable it. Any other unusable value — `0`, a negative, `Infinity`,
`NaN` — falls back to the 2-second default rather than turning the warning off, so it cannot be
lost to a mistake. Say `false` when you mean off; raise the number for a seed script or a data
migration whose transactions are legitimately long.

The warning is development-only and never fires in production, whatever the config says. It is a
diagnostic, not a limit: nothing cancels a long transaction.

## Policies

A model carries a **list** of policies. Every member of a policy is optional; a model with none
pays a single `undefined` check per query.

```ts
import { AccountPolicy } from "./generated"

export class Account extends AccountModel {
  static $policies: AccountPolicy[] = [
    {
      scope: (ctx) => ({ organizationId: ctx.user.organizationId }),
      onCreate: (ctx, data) => ({ ...data, organizationId: ctx.user.organizationId }),
      onUpdate: (ctx, data) => ({ ...data, organizationId: ctx.user.organizationId }),
    },
  ]
}

register("Account", Account)
```

The `AccountPolicy` annotation is not decoration. TypeScript does not contextually type an
initializer from an inherited static declaration, so without it `ctx` and `data` are implicitly
`any` — the generator emits one of these per model so you never write the generic form by hand.

Policies compose by listing them, in the order they apply:

```ts
static $policies: AccountPolicy[] = [softDeletes<Account>(), new TenantPolicy()]
```

Entries may be objects or classes. A class is instantiated once, and extending the generated
`AccountScopedPolicy` makes `scope`, `onCreate` and `onUpdate` abstract members — so a policy that
scopes reads but forgets the write halves is a compile error rather than a runtime refusal:

```ts
class TenantPolicy extends AccountScopedPolicy {
  scope(ctx: PolicyContext) { return { organizationId: (ctx.user as User).organizationId } }
  onCreate(ctx: PolicyContext, data: Prisma.AccountCreateInput) { … }
  onUpdate(ctx: PolicyContext, data: Partial<Prisma.AccountCreateInput>) { … }
}
```

Each level of the prototype chain contributes its own array and they concatenate **base first**, so
a shared model base can impose a policy a subclass can only narrow, never drop.

| Member | When it runs | What it does |
| --- | --- | --- |
| `before(ctx)` | First | Return `false` (or throw) to deny outright. |
| `scope(ctx)` | Reads and row-matching writes | Returns a `where` fragment `AND`ed into `args.where`. A policy can only ever **narrow**. |
| `onCreate(ctx, data)` | `create` / `createMany` / `upsert` | Defaults or validates the payload. An insert has no `where` for a scope to narrow. |
| `onUpdate(ctx, data)` | `update` / `updateMany` / `upsert` | Defaults or validates the payload of a write to existing rows. |
| `redact(ctx, row)` | Shaping | Removes fields from a fetched row. |

**Anything that names another model is scoped as a read of that model**, whatever the statement
around it is doing. That covers all four ways a query reaches a model it did not name — an
`include` / `select` node, a `_count` entry, a relation filter in a `where`, and a relation
ordering in an `orderBy` — and it means `context.operation` is `findMany` inside each of them:

```ts
User.create({ data, include: { accounts: true } })      // Account's scope, not its onCreate
User.updateMany({ where: { accounts: { some: {} } } })  // Account's read scope, not its write one
```

The children are being *read back*; only the row named by the statement itself is being written.
Nested writes under `data` are a different tree and scope themselves as writes.

**A scope alone does not protect writes, and the ORM says so rather than assuming.** A `scope`
narrows *which rows* a statement may touch and says nothing about the values written, so a
tenant-scoped `update` could hand one of your own rows to another tenant — after which you can
neither read it back nor put it right. Two guards, each asked of the policy that carries the scope
rather than of the list as a whole:

- a `create` under a policy with `scope` and no `onCreate` is refused;
- an `update` writing a column that policy's own `scope` selects on is refused with
  `ScopeEscapeError` unless it has an `onUpdate`.

`onUpdate: (_ctx, data) => data` is a complete and legitimate answer. The point is that the policy
says which. The guard reads scope-owned columns off the top level of the returned fragment, so
`{ organizationId: 7 }` is understood and a combinator scope such as `{ OR: [...] }` is not
attributed to any column and is not checked.

**Policies rewrite the argument tree, never SQL.** That is what makes a scope two lines instead of
string surgery, what keeps the two relation strategies interchangeable, and what keeps the plan
cache sound — policies run *before* the plan key is computed, so two differently-scoped users
never share a plan.

### Every path that reaches another model carries that model's policies

This is the guarantee the whole hook exists for, and it is worth stating as a rule rather than as
a list of cases — because it was found and fixed one case at a time, and the list is longer than
it looks. A model's policies apply when its rows are reached through:

| | |
| --- | --- |
| `include` / nested `select` | the child's scope narrows the child query |
| a folded relation (the `lateral` strategy) | the scope lands *inside* the subquery |
| `where: { rel: { some: … } }` | the `exists` subquery is scoped |
| `_count: { select: { rel: … } }` | you can only count rows you could read |
| `orderBy: { rel: … }` | you can only sort by rows you could read |
| `data: { rel: { create / connect: … } }` | the child's `onCreate` runs; a `connect` cannot reach a row you cannot read |

```ts
await User.findMany({ include: { accounts: true } })
// the accounts subquery carries Account's scope, under either strategy
```

**`redact` applies to nested rows too**, including relations folded into the parent's statement by
the `lateral` strategy. It is the one policy member that cannot be expressed as an argument — it is
a row transform — so it is applied after shaping rather than before planning.

Two limits, both deliberate:

- **`asSystem` suspends all of it**, for the whole async subtree, not just the model you named.
- **A policy only applies if its class is the registered one.** See [Setup](#your-model-class) —
  this is the gap the guarantee genuinely has, and `assertPoliciesRegistered` is the backstop.

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

### A scoped model and `upsert`

`upsert` compiles its `where` into an `on conflict` target, which is a key rather than a filter, so
there is nowhere for a scope to go — and running it anyway would write outside the scope. A
scoped model is therefore refused on that path.

There is a second path, and it is not refused: leave the conflict key out of `create`, and the
call runs as a scoped read and a scoped write inside one transaction.

```ts
// refused on a scoped model — the where becomes an `on conflict` target
Account.upsert({ where: { publicId }, create: { publicId, … }, update: { … } })

// runs, and both halves are scoped
Account.upsert({ where: { publicId }, create: { … }, update: { … } })
```

That second form is also what Prisma means by an upsert generally, and its semantics are worth
knowing: the `where` **selects** and contributes nothing to the insert, so the created row's
`publicId` above is the schema default, not the one you searched for.

### Soft deletes

Ships as a policy, which is the proof the hook is expressive enough to be worth having:

```ts
import { softDelete, softDeleteMany, softDeletes } from "gemi/orm"

export class User extends UserModel {
  static $policies = [softDeletes<User>()]  // reads skip rows with a deletedAt
  static delete = softDelete(User)          // delete becomes an update
  static deleteMany = softDeleteMany(User)
}
```

`deletedAt` must be a nullable `DateTime` on the model (`field` overrides the column name). The
read half applies to nested reads for the same reason every policy does — a deleted `Account` does
not appear under `User.findMany({ include: { accounts: true } })` without anything being written at
the include site, which is the half ORM-level soft deletes usually get wrong.

Composing it with your own is one list:

```ts
static $policies: UserPolicy[] = [softDeletes<User>(), new TenantPolicy()]
```

`softDeletes()` carries an `onUpdate` pass-through, because `softDelete()` writes the very column
the policy scopes on and something has to say that is intended. That permission is **per policy**:
a tenant policy sitting beside it in the same list still has to answer for its own column.

`field` is constrained to the model's own keys, so pointing it at a column that does not exist is a
compile error rather than a `no such column` on the first read.

## Errors

Every failure is a typed error from `gemi/orm`, not a driver string.

| Error | Raised when |
| --- | --- |
| `RecordNotFoundError` | An `…OrThrow` operation matched nothing. |
| `UniqueConstraintError` | A unique constraint was violated, with the constraint identified. |
| `PolicyDeniedError` | A `before` denied, or `ctx.user` was read with no user. |
| `ScopeEscapeError` | An `update` wrote a column its own policy's `scope` selects on, with no `onUpdate`. |
| `UnknownFieldError` / `UnknownRelationError` | A name that is not on the model. |
| `UnsupportedQueryError` | A query shape the compiler does not implement — with what and why. |
| `ModelNotRegisteredError` / `UnregisteredPolicyClassError` | Registry problems (see [Setup](#your-model-class)). |
| `RelationDepthExceededError` | An include tree past `MAX_RELATION_DEPTH`. |
| `ParameterLimitError` | A statement exceeding the dialect's parameter ceiling. |
| `MissingRequiredValueError` | A write leaving a required column with no value and no default. |
| `DecodeError` | A column the driver returned that cannot be read as its declared type. |
| `UnsupportedByDesignError` | A subclass of `UnsupportedQueryError` for the arguments under [Not in scope](#not-in-scope) — it says *decision*, where the parent says *not yet*. Catch this one to tell them apart. |
| `UnsupportedDialectError` | A model operation on a dialect with no compiler — MySQL and MariaDB. See [Dialects](#dialects). |
| `ReturningUnsupportedError` | A write on a dialect without `RETURNING`, which is the same gap seen from the write path. |
| `StaleSchemaArtifactError` | Generated files predate the running gemi. Re-run `prisma generate`. |
| `MalformedRelationError` / `MissingModelSchemaError` / `UnregisteredRelationTargetError` | The generated artifact and the registry disagree — the same family as the two above, and the same fix. |

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

## Raw SQL

The ORM does not implement every SQL shape, and that is deliberate. What it owes you is somewhere
for the rest to go — not just a way to run one hand-written statement, but a way to *compose* SQL,
because a predicate built conditionally and passed around is the shape raw SQL actually takes in an
application.

```ts
import { DB } from "gemi/facades"
import { sql, join, empty } from "gemi/orm"

const filters = []
if (q) filters.push(sql`"name" ilike ${`%${q}%`}`)
if (organizationId) filters.push(sql`"organizationId" = ${organizationId}`)

const where = filters.length ? sql`where ${join(filters, " and ")}` : empty

const rows = await DB.query<Product>(
  sql`select * from "Product" ${where} order by "position" limit ${20}`,
)
```

| | |
| --- | --- |
| `` sql`…` `` | A fragment. Every `${value}` is **bound**; a `${fragment}` is spliced in, carrying its own parameters. Nests to any depth. |
| `join(items, sep)` | Fragments *or* values, joined. `join(ids)` is `$1, $2, $3`. An empty list is `empty`, not a dangling separator. The separator is **glue only** — see below. |
| `empty` | The fragment that contributes nothing, so a conditional predicate stays a value instead of becoming a branch. |
| `DB.query(fragment)` | The rows. |
| `DB.execute(fragment)` | How many rows the statement **touched**. |

Three properties worth knowing, because they are the reason this is not just `DB.sql`:

- **Placeholders are assigned at assembly, not at authoring.** SQLite writes `?` and Postgres
  writes `$1`; a fragment does not know where it will land, so the numbering happens once the whole
  statement exists. The same fragment can be nested, reused twice in one statement, or built before
  the dialect is known.
- **It runs on the ambient transaction.** A `DB.query` inside `Model.transaction` joins it, exactly
  as a `User.create` does. A raw statement that quietly committed while its neighbours rolled back
  would be worse than no raw statement at all.
- **A plain string is refused.** Accepting one would make an interpolated template literal the path
  of least resistance, which is the injection everything else here exists to prevent.

**Policies do not apply here, and cannot.** A policy scopes a *model's* queries by rewriting the
argument tree; a raw statement has no argument tree and no model behind it, so nothing scopes it and
nothing redacts its rows. That is not a gap to be closed later — it is what "raw" means. If the
statement reads a policied model, the tenant predicate is yours to write, and
[`Every path that reaches another model carries that model's policies`](#every-path-that-reaches-another-model-carries-that-models-policies)
stops at this door.

Values are handed to the driver as they arrive, with two exceptions that exist so a fragment means
the same thing on both dialects: a `Date` binds as milliseconds on SQLite — which is what the ORM
stores — and a boolean as `0`/`1`.

A plain object is **not** JSON-encoded for you. The compiler only knows to do that because a field
says `Json`, and guessing from the value would turn a mistyped parameter into a successfully-written
string. What the driver then does with it differs: Bun binds an object into a Postgres `jsonb`
column correctly, and on SQLite binds it to something no row matches. Stringify it yourself if the
column is JSON and you want the same answer on both.

**The separator `join` takes is written into the SQL**, so it is not a free string: whitespace,
commas, or `and` / `or`, and nothing else. Anything more expressive is legitimate but has to say so
with `unsafeSql`, which keeps that the only door:

```ts
join(filters, " and ")               // fine
join(parts, unsafeSql(") and ("))    // fine, and visibly a decision
join(ids, req.query.sep)             // refused
```

That is an allowlist rather than a blocklist on purpose. The obvious blocklist — reject quotes,
semicolons and comment markers — lets `") or 1=1 union select password from Users where 1=(1"`
through, which has none of them and is still an injection.

**Only a fragment built by `sql`, `join`, `unsafeSql` or `empty` is spliced.** Anything else in an
interpolation slot is bound — including an object that merely *looks* like a fragment, which is what
a parsed request body can be made to contain. That check is membership, not shape, precisely so that
`{"text": "…", "binders": []}` arriving from outside the program is a parameter and not a statement.

### The rowcount is a primitive, not a diagnostic

```ts
const won = await DB.execute(
  sql`update "Reservation" set "status" = 'claimed'
      where "id" = ${id} and "status" = 'reserved'`,
)
if (won === 0) throw new AlreadyClaimed()
```

`1` means this caller won the compare-and-swap and `0` means it lost. That is the whole concurrency
control for a large class of code, so an API that discarded the number could not express it.

### `unsafeSql` — the one door into the SQL text

```ts
import { unsafeSql } from "gemi/orm"

// A literal in this file. Never a request, a form, a header or a database row.
const REAPER = unsafeSql(`'reaper'`)

await DB.query(sql`
  select … from "Job" where "name" is distinct from ${REAPER} …
`)
```

**Never give it a value that came from outside the program.** There is no escaping and there will
not be — escaping that is "usually right" is worse than none, because it survives review.

It exists because plan quality can depend on *not* parameterising. A partial index declared
`where "name" is distinct from 'reaper'` is only usable if the planner can prove the query's
predicate matches the index's, and a bound parameter is opaque at plan time — so `$1` there means a
sequential scan of the whole table instead of an index hit. The constant has to be in the text. The
same applies to identifiers and sort directions, which cannot be parameters in SQL at all; the rule
is the same for those, and it is about where the value came from, not what it is.

`DB.sql` is unchanged and still Bun's own tagged template, for a single self-contained statement
that needs none of this. **Whether it joins the ambient transaction depends on the dialect**, so use
`DB.query` when that matters:

- On **Postgres** it does not. The pool hands it a different connection, so a `Model.transaction`
  that rolls back leaves a `DB.sql` write behind.
- On **SQLite** it does, because `DatabaseManager` gives SQLite a single connection and the
  statement is therefore inside the open transaction.

The direction is the awkward one: a `DB.sql` write inside a transaction rolls back correctly in
development on SQLite and survives the rollback in production on Postgres. `DB.query` and
`DB.execute` join the transaction on both.

## `Json` columns

A `Json` column round-trips whatever you give it: an object, an array, a string, `null` — and a
number or boolean on SQLite, with the one exception below. The value is stored as JSON and comes
back as the same JavaScript value, on both dialects and whether it is read at the root or nested
inside an `include`.

Two things are worth knowing:

- **A bare JSON number or boolean is refused on Postgres.** `metadata: 42` raises rather than being
  stored, because the driver binds it as an integer and the column is `jsonb`. Wrap it — `{ value:
  42 }` — or store it as a string. SQLite has no such limit.

  **This is the one shape where gemi diverges from Prisma**, which stores it on both dialects, so it
  is worth knowing if you are porting code rather than writing it fresh. It is a trade rather than
  an oversight: the encoder that accepted it serialised first, which stored `42` as the jsonb
  *string* `"42"` — and only looked correct because the decoder re-parsed it on the way out, so the
  value was wrong in the database the whole time. Failing loudly beats storing the wrong thing.
- **A string is a string.** `metadata: "42"` stores the JSON string `"42"`, not the number, and
  `metadata: '{"a":1}'` stores that text as a string rather than as an object. If you want an
  object, pass an object.

> **Upgrading:** `Json` values written by a *pre-release* build of this ORM on Postgres were stored
> as JSON **strings** rather than as objects — `{ a: 1 }` landed as `"{\"a\":1}"`. Reads undid it,
> so nothing looked wrong from inside the ORM, but the column was wrong for anything else that read
> it. Those rows now read back as strings. Re-seed development databases; there is no released
> version affected.

## Dialects

**SQLite and Postgres** are built and tested, on every operation, against a differential harness
that runs each query through both gemi and Prisma and compares the rows. `DatabaseManager` infers
the dialect from `DATABASE_URL`.

MySQL and MariaDB are **not** implemented, and that is a statement about the supported matrix rather
than a release that is coming. The dialect seam is there and `DatabaseManager` already recognises
them, but nothing is built or tested behind it.

**The connection still works, which is the part worth being precise about.** Bun's client speaks all
four dialects, so pointed at MySQL an application connects, `DB.query` / `DB.sql` run, and
transactions work. What is missing is a `SqlDialect` for the query *compiler*, so every model
operation raises `UnsupportedDialectError` — with a message that says exactly that, rather than
leaving you to conclude the database is unusable.

In development the mismatch is reported **at boot** instead of on the first model query, since
otherwise an application pointed at MySQL starts, passes a health check, and fails on the first
`findMany`. `ormSupports(dialect)` is exported if you would rather assert it yourself:

```ts
import { ormSupports } from "gemi/orm"
if (!ormSupports(DB.dialect)) throw new Error("this deployment needs Postgres")
```

## Not in scope

Stated so you can plan around them rather than discover them:

- **No identity map and no unit of work.** Two queries for the same row give you two objects. Half
  an identity map is worse than none.
- **No lazy loading.** A relation you did not `include` is absent, not a proxy that queries when
  touched.
- **No multi-field relations in a nested write.** `@relation(fields: [a, b], references: [c, d])`
  now works everywhere a relation is *read* — `include` under either strategy, a relation filter,
  `_count`, and an `orderBy` through a relation all correlate on every field. What is still refused
  is reaching one from a nested write, and the error names the fields on both sides and the
  operation it came from, rather than joining on the first field and writing plausible wrong rows.
  Pending rather than declined.
- **No migrations, no schema DSL.** Prisma owns both, and gemi must not shadow the Prisma CLI.
- **No `distinct`, and this one is deliberate rather than pending.** Prisma applies it **in
  memory** — its query log shows no `DISTINCT` at all, so `take` neither reduces the rows pulled
  nor paginates by group. Reproducing that faithfully would mean reading the whole result set and
  deduplicating in JavaScript behind an argument that reads like a database operation; emitting a
  real `DISTINCT ON` instead would silently diverge from Prisma. Write it as SQL.
- **No `cursor`, also deliberate.** It is only correct under a *total* ordering, which Prisma does
  not enforce — under a non-unique `orderBy` it skips or repeats rows at the page boundary. Use
  `take` with a `where` on the last row's sort key, or compose the keyset comparison with `sql`.

Both of the last two throw `UnsupportedByDesignError`, which says *"and this is a decision rather
than a gap"* rather than *"yet"* — so a refusal you can plan around reads differently from one that
might lift next release.

## See also

- **[Rows and entities](./orm-rows-and-entities.md)** — POJOs, `track` + `save`, and `wrap`.
- **[Authentication](./authentication.md)** — `app/config/auth.ts` and the user provider seam.
  `OrmAuthenticationAdapter` (exported from `gemi/kernel`, beside the Prisma one) implements all
  twenty-two methods of `IAuthenticationAdapter` on this ORM and can be selected in its place. The
  starter template still points at the Prisma adapter; switching it is a per-application call.
- **[Authorization](./authorization.md)** — route-level authorization, which policies complement
  rather than replace.
