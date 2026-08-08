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
| Query argument and result **types** | gemi (`prisma generate`, from the gemi generator) |
| Runtime model metadata | gemi (a Prisma generator block, run by `prisma generate`) |
| SQL compilation, execution, result shaping | gemi |
| Transactions, policies, hooks | gemi |

**You do not install `@prisma/client`.** Nothing in gemi imports it, nothing it generates imports
it, and no Prisma command needs it: the `prisma` CLI depends on `@prisma/config` and
`@prisma/engines`, so `migrate dev`, `migrate deploy`, `db push` and `migrate diff` all run without
a client anywhere in the project.

## Setup

```sh
bun add -d prisma
```

That is the whole dependency. Prisma still owns your schema and your migrations, and you still run
`prisma migrate dev` — you just never generate or install a Prisma client.

Add the gemi generator to `schema.prisma`. It is the only generator block you need:

```prisma
generator gemi {
  provider = "gemi-orm-generator"
  output   = "../app/models/generated"
}
```

<details>
<summary>Upgrading from a version that required <code>generator client</code></summary>

Earlier releases emitted model bases that did `import type { Prisma } from "@prisma/client"`, so
the generator refused to run without a `generator client` block. The import was type-only and never
reached a bundle — but it still had to *resolve*, which put a 74MB package into the dependency
graph of every gemi app, and made it generate a further 23MB of client it never called, for types
that are erased at build. The `prisma` CLI keeps its own copy of the query engine either way — that
is what runs your migrations — so what goes away is the client and the duplicate, not the engine.

To upgrade: delete the `generator client` block from `schema.prisma`, run `bun remove @prisma/client`,
and re-run `bunx prisma generate`. The regenerated `models.ts` imports its types from `gemi/orm`
instead. Your queries do not change.

Two things get *better* rather than staying equal, because the types now describe gemi rather than
Prisma's query engine:

- `cursor` and `distinct` are compile errors. gemi refuses both
  permanently and by design, and Prisma's argument types admitted
  them — so code that type-checked used to throw at runtime.
- `_sum` and `_avg` are restricted to numeric columns, and `_min` / `_max` to orderable ones,
  matching what the aggregate compiler actually accepts.

If you passed `Prisma.DbNull` or `Prisma.JsonNull` to a `Json` column, import them from `gemi/orm`
instead — see [Json columns](#json-columns). Prisma's own sentinels keep working; gemi recognises them
structurally rather than by identity.

</details>

<details>
<summary>Migrating model by model, with a Prisma client still in the app</summary>

Nothing requires the switch to happen all at once. A `PrismaClient` and the gemi ORM coexist
fine — but they are **two connection pools against the same database**, and by default nobody
chooses their sizes.

`DatabaseConfig.url` defaults to `DATABASE_URL`, which is normally the same URL the Prisma client
already has. So the moment you register your first gemi model, the process holds Prisma's pool and
gemi's Bun `SQL` pool at once, and their two defaults were each picked as though they were the only
one. Against a managed Postgres with a connection cap — or a PgBouncer with a fixed pool — the
symptom is connection exhaustion under a load that used to be fine, and it names neither library.

Decide the split before you start rather than after the first incident:

```typescript
export default defineDatabaseConfig({
  url: process.env.DATABASE_URL,

  // Passed straight through to Bun's `SQL` client.
  options: { max: 5 },   // gemi's share of the budget
});
```

and lower Prisma's `connection_limit` by the same amount, so the two together stay inside the
budget one of them used to have. Rebalance as models move across; when the last one has, drop the
Prisma client and give gemi the whole budget.

Pointing gemi at a *different* `url` is the other honest answer — a separate pool with its own cap,
at the cost of two things to configure per environment. The same arithmetic applies to gemi's own
second pool: see [Connections](#connections).

</details>

Then `bunx prisma generate`. You get three files under `app/models/generated/`:

- `schema.ts` — runtime metadata: tables, columns, types, defaults, relations.
- `models.ts` — a typed base class per model, carrying every operation.
- `index.ts` — registers every model by name.

**The output is committed on purpose.** Diffs stay reviewable and CI needs no codegen step.

### Columns the generator refuses

One kind of column stops generation with an `UnsupportedSchemaError` naming the model and field,
rather than being skipped:

| Column | Why |
| --- | --- |
| `Decimal` | Prisma types it as `Prisma.Decimal`; SQLite stores a REAL and the driver returns a JS number, so the value would be a float pretending to be an arbitrary-precision decimal. |

**Refused rather than omitted, and the whole generation fails rather than the one field.** Skipping
the column would generate cleanly and then hand back a row shape that silently disagrees with the
type Prisma gave you — which is the failure this ORM is built to make impossible. One unsupported
column means no `schema.ts`, no `models.ts` and no `index.ts` for any model, so the problem is
visible at the moment you introduce it.

A `Unsupported(...)` column is different and is *not* refused: Prisma's own client omits those from
its result types, so omitting them is what keeps the shapes identical.

```
UnsupportedSchemaError: User.price is a Decimal, which the gemi ORM does not support yet:
Prisma types a Decimal field as `Prisma.Decimal`, but SQLite stores it as a REAL and the
driver returns a JS number — so the value would be a float pretending to be an
arbitrary-precision decimal, losing exactly the precision the type exists to keep.
Keep using the Prisma client for this model, or change the field's type.
```

A scalar type the generator cannot map at all — a future Prisma addition — raises the same error.
Both are *generator* errors rather than runtime ones, so neither is in the
[errors table](#errors) below, which is about queries. If you see one, the fix is in
`schema.prisma`.

**A scalar list used to be in this table and no longer is.** `tags String[]` is implemented on
Postgres — see [Scalar lists](#scalar-lists-postgres-only). The refusal did not disappear so much as
move: this artifact is dialect-agnostic on purpose, because `DATABASE_URL` can name a different
database than `prisma generate` saw, so refusing here refused the column for Postgres too. SQLite
now declines it at query time instead, with a message naming the dialect. `Decimal[]` is still
refused, by the row above rather than by a rule about lists.

### Column defaults

`@default(...)` is filled by one of two parties, and the split is not a style choice — it is forced
by the DDL Prisma emits. Read the migration for a model with the usual four columns:

```sql
"id"        INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,     -- @default(autoincrement())
"publicId"  TEXT     NOT NULL,                               -- @default(cuid())
"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,     -- @default(now())
"updatedAt" DATETIME NOT NULL,                               -- @updatedAt
```

`publicId` and `updatedAt` carry **no database default at all**. Prisma generates them in its
client, so a row inserted without them violates NOT NULL — if gemi does not supply them, nothing
does.

Prisma's client fills **four** id functions this way — `cuid`, `uuid`, `nanoid` and `ulid` — and
every one of them gets a bare `TEXT NOT NULL`. All four are gemi's to supply:

| `@default(...)` | Filled by | Notes |
| --- | --- | --- |
| `autoincrement()` | the database | The one identity column the database really does own. |
| `dbgenerated(...)` | the database | You said so in as many words. |
| `cuid()` / `cuid(1)` | gemi | cuid v1 — 25 characters, `c` and 24 lowercase alphanumerics. |
| `cuid(2)` | — | **Refused at generate time.** See below. |
| `uuid()` / `uuid(4)` | gemi | v4: 122 random bits. |
| `uuid(7)` | gemi | v7: 48 bits of big-endian milliseconds, then randomness — so v7s sort by creation time. |
| `nanoid()` / `nanoid(n)` | gemi | nanoid's url alphabet; 21 characters, or `n`. |
| `ulid()` | gemi | 26 characters of Crockford base 32, timestamp first, so ULIDs also sort by creation time. |
| `now()` | gemi | Not the database's `CURRENT_TIMESTAMP` — see below. |
| a literal | gemi | `@default("en-US")`, `@default(2)`, `@default(false)`. |
| `@updatedAt` | gemi | Not a `@default` at all, and stamped on **create** as well as on update. |

**The version argument is part of the default, not a detail of it.** `uuid()` and `uuid(7)` are one
identical `TEXT` column apart in the DDL and two different kinds of identifier in practice — a v7 is
time-ordered and a v4 is not, and both render as a UUID, so a column filled with the wrong one looks
completely normal. gemi records the version in the generated artifact and mints what the schema
asked for. The same goes for `nanoid(n)`'s length.

`uuid(7)`'s ordering is per *millisecond*: everything after the timestamp is random, so two ids
minted in the same millisecond have no defined order between them. RFC 9562 makes the monotonic
counter that would fix that optional, and neither Prisma nor gemi implements it.

**`now()` is generated in gemi even though the column has a database default**, and the reason is
storage form rather than correctness. SQLite stores `CURRENT_TIMESTAMP` as the *text*
`YYYY-MM-DD HH:MM:SS`, while Prisma stores a `DateTime` as integer milliseconds. Letting the
database fill it would write a different shape than Prisma writes, and drop sub-second precision.

One instant is resolved per operation, not per field, so `createdAt` and `updatedAt` come back from
a `create` as the *same* timestamp — which is what Prisma does:

```ts
const user = await User.create({ data: { email: "a@b.c" } })
user.createdAt.getTime() === user.updatedAt.getTime()   // true
```

**A value you pass beats the default**, for every row in the table above:

```ts
await User.create({ data: { email: "a@b.c", publicId: "fixed", createdAt: new Date(2020, 0) } })
```

And a nullable column with no default is **omitted from the insert** rather than bound as `null`,
so a database default you added by hand in a migration still applies.

#### Defaults the generator refuses

Two, and both are refused for the reason `Decimal` is: emitting a value that silently disagrees with
what Prisma would have written is worse than a generation error naming the field.

| `@default(...)` | Why |
| --- | --- |
| `cuid(2)` | Prisma mints a cuid2 through `@paralleldrive/cuid2`, which hashes with SHA-3. gemi cannot reproduce it, and the formats do not even agree: a cuid2 is 24 characters and letter-first, a v1 is 25 and always starts `c`. Use `cuid(1)`, or keep the Prisma client for this model. |
| `uuid(n)`, n ∉ {4, 7} | The only UUID versions Prisma generates. Its own client throws for the rest; gemi says so at generate time instead. |

#### A default the generator does not recognise

A function default this generator has no case for — one Prisma adds after your version of gemi, or a
provider-specific one — is recorded as the database's, because that is the only guess available. If
that guess is wrong the column has no default anywhere, so `prisma generate` says so:

```
gemi ORM: Organization.publicId defaults to auto(), which this generator does not
recognise, so it is recorded as a database-side default and the ORM will omit the column
on insert. If Prisma fills that default in its own client — as it does for cuid, uuid,
nanoid and ulid — the column has no default in the database either, so every write to
Organization either fails on NOT NULL or silently stores NULL. Give the field a default
the ORM knows, or upgrade gemi.
```

**A nullable column gets the same warning, and it is the one worth reading.** A required column
fails loudly on the first write. A nullable one takes the NULL, and nothing fails at insert or at
read — you find out later, when a lookup by that id returns nothing. That is why the warning does
not suggest making the field optional: it would convert the loud failure into the silent one.

A warning rather than a refusal, though: most `dbgenerated(...)` columns really are the database's,
and refusing would break schemas that generate and run correctly today. It is a warning rather than
*nothing* because the generator is the only place that still knows the function's **name** — by the
time a row is rejected, all you have is a column that ought to have had a default.

### Your model class

The generated base is not the class you write code on. Subclass it, put the subclass in a barrel,
and list that barrel on your Kernel:

```ts
// app/models/User.ts
import { UserModel } from "./generated"

export class User extends UserModel {}
```

```ts
// app/models/index.ts
export { User } from "./User"
```

```ts
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel"
import * as generated from "../models/generated"
import * as models from "../models"

export default class extends Kernel {
  models = [generated, models]
}
```

`boot()` registers every model class those modules export under the name its schema carries, later
modules winning — so each subclass takes the name its generated base was holding — and then checks
that no policied class lost its name to something else.

**Upgrading an app that already has models?** `models` defaults to `[]`, so until you write that
line your app behaves exactly as it did before — which is the arrangement the rest of this section
is about. A Kernel with an empty `models` and a populated registry warns at boot in development.
[UPGRADE.md](https://github.com/nstfkc/gemi/blob/main/UPGRADE.md) has the short version.

**Why the framework does this rather than you.** A relation read resolves its target through the
registry by name, so whatever is registered under `"User"` is the class that runs inside every
nested `include`. If that is the generated base while your policy lives on your subclass, the
policy applies to root queries and is skipped inside includes — scoped one way, unscoped the other.
The registration used to be a `register("User", User)` line next to each subclass, and forgetting
it is invisible: `Model.$exec` raises `UnregisteredPolicyClassError` when a class carrying policies
is *queried* while a different class owns its name, but that guard is narrower than it sounds and
the gap runs the wrong way. **A model you only ever read through an `include` never trips it** — the
include resolves the name to the unpolicied base, nothing diverges from nothing, and the rows come
back unscoped with no error. That is the shape a membership or pivot model usually has, and exactly
the kind that carries a tenant scope.

Deriving the registration from the module removes the mistake instead of reporting it. The name is
not a string you retype; it is `$schema.name`, which the generator wrote and your subclass inherits.

`register` still exists and still works, for a class you want registered from a module you are not
handing to the Kernel. And you can call the same thing directly — `registerModels(generated,
models)` from `gemi/orm` — in a script or a test that boots no Kernel.

Two classes in **one** module claiming the same model raise `AmbiguousModelRegistrationError`,
unless one extends the other. A generated base and the subclass over it are not ambiguous — the
subclass wins. Nor are a class and a typed view over it, *as long as the view adds no policies of
its own*: the class wins and the view inherits its policies, so which one the registry holds changes
nothing. Two siblings both written for the same model are ambiguous, and `register` is how you say
which.

Across **different** modules there is no election at all — the later one simply wins. What catches a
bad outcome there is the audit that runs at the end, so a conflict between two policied classes is
still refused; two unpolicied ones resolve by import order, which changes no query's scope.

**A view that carries its own policies is refused rather than chosen between.** The registry holds
one class per name, so registering `AdminUser` would apply its narrowing to every nested read of
`User`, and leaving `User` registered would skip `AdminUser`'s policies entirely — both silent. Keep
such a class out of the modules you hand to `Kernel.models` and query it directly where you want the
narrowing:

```ts
// app/models/views/AdminUser.ts — not exported from app/models/index.ts
export class AdminUser extends User {
  static $policies: UserPolicy[] = [{ scope: () => ({ archived: false }) }]
}

const rows = await AdminUser.findMany({ … })   // narrowed, at the call site
```

If it is not a view but the model itself, move the policies onto the class the name resolves to and
every subclass inherits them everywhere.

#### What this still cannot see

Modules you hand it. A policied class in a file that no barrel re-exports is invisible to the
Kernel exactly as it was to a forgotten `register` line — which is the reason for the barrel: one
file to add a model to, and a missing line in it is a thing you can notice.

`gemi check models` is what notices it for you:

```
$ gemi check models
Checked 10 model files against 13 registered models. Every policied class owns its name.
```

It walks `app/models`, imports every file, and asks the same question `Kernel.models` asks — of the
classes the directory holds rather than of the modules the Kernel was handed. A policied class no
declared module registers is reported with the export that would fix it, and the command exits `1`,
so it belongs in CI:

```yaml
- run: bunx gemi check models
```

Three things worth knowing before you wire it up.

**It imports your model files.** There is no way to find a class without evaluating the module that
declares it. A file that *does* something when imported does it here — `--ignore <paths>` skips
paths under `app/models`, comma-separated and repeatable, and the command prints what it skipped. Tests, type tests,
benchmarks, `.d.ts` files and any directory with its own `package.json` are skipped already.

**It does not credit a `register` call your file made on the way in.** A class that owns its name
only because loading its module said so loses it the day nothing imports the module, which is the
failure being checked for. The registry is put back to what `Kernel.models` made it before each file
is audited.

**It reports one thing: a class carrying policies the registered class does not.** A typed view
carrying its own narrowing is *supposed* to be absent from the declared modules — see above — and so
is an unpolicied class written against a model's schema, which
`AmbiguousModelRegistrationError` likewise tells you to keep out. A checker that demanded you export
either would be telling you to undo what the framework told you to do, and would turn a working boot
into that error.

Run it against another directory with `--dir`. And if it cannot load your Kernel — the module list
lives there, so it has to import it, and a Kernel's import graph does not have to survive a bare
runtime import (`?raw` imports, virtual modules, asset imports) — name the modules yourself instead:

```bash
gemi check models --models app/models/generated,app/models
```

Prefer all of this over a boot-time scan: enumerating the filesystem at start-up would couple the
framework to your bundler and make every production process pay, on every start, for a mistake that
can only be made while editing.

`assertPoliciesRegistered` is the same audit without the registration, for running over modules the
Kernel does not own — a test over a package's models, a script that boots nothing:

```ts
import { assertPoliciesRegistered } from "gemi/orm"
import * as generated from "@/app/models/generated"
import * as models from "@/app/models"

assertPoliciesRegistered(generated, models)
```

`auditModelRegistrations` is the same rule again, returning the errors instead of throwing the first
— which is what `gemi check models` uses to sort a leak from a view.

## Querying

Fifteen operations, with Prisma's argument types verbatim:

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

**An `update` whose `data` sets no column reads the row rather than writing it.** `data: {}` is
accepted and comes back with the row unchanged, honouring `select`, `include` and `_count` exactly
as any other `update` does, and a `where` that matches nothing still raises `RecordNotFoundError` —
it is the same plan with a `select` where the `update … returning` would have been, not a different
path. Prisma answers the same way. The case is not contrived either: it is what a payload assembled
from optional fields degenerates to when the caller changed nothing, and it used to turn a Save with
nothing edited into an error. A `data` carrying only
nested writes behaves identically, and for the same reason — there is nothing to set on the parent,
so the statement reads, and the nested steps still run.

`updateMany({ where, data: {} })` answers `{ count: 0 }`, and the count is a **constant** rather
than the number of rows the filter selected. Measured against Prisma with two of three rows
matching, again with a filter matching none, and again with no `where` at all: the same zero every
time, and no row touched. The filter is still compiled, so an unknown field in it is refused whether
or not there happened to be anything to write.

Both hold on a model carrying `@updatedAt` too, which takes saying because the stamp looks like it
should get in the way. It does not: **`@updatedAt` follows the column rather than the call.** A
statement that sets at least one column stamps it; one that sets none — an empty `data`, or a `data`
of only nested writes whose child holds the foreign key — leaves it alone, because nothing about
this row was updated. Prisma draws the line in the same place, measured on rows seeded to a known
instant rather than inferred from the attribute's name.

A `data` of `null` is refused with `InvalidArgumentError`, and the distinction is worth one line:
now that an empty object reads the row back, a null one would read it back too, which is a malformed
call answered with a row. The message says the difference — an empty object is accepted, `null` is
not.

**`take` and `skip` must be integers, and are refused rather than coerced.** They are the only
arguments whose *sign* decides the SQL — a negative `take` means "the last N", which flips every
ordering term — so a `take` arriving as a string does not merely have the wrong type, it takes the
wrong branch: `take: "-2"` used to return the **first** two rows, in the opposite order, with no
error. A query string is exactly where a string `take` comes from, so parse it before you pass it:

```
Invalid 'take' (User.findMany). Expected an integer, got "-2".
```

A negative `skip` is refused too — it counts rows to pass over — and both rules are the ones that
already applied inside an `include`.

> **Divergence from Prisma, on purpose.** Prisma accepts a *fractional* `take` and truncates toward
> zero; this refuses it. Binding one instead is a `datatype mismatch` error from SQLite and a
> silently different row count on Postgres, which rounds — so the fraction has no single meaning to
> match. One rule at both levels, failing loudly, beats three behaviours.
>
> **Where it bites is the boundary, not the query.** The value has to be truncated where it enters
> the application, not where it reaches the ORM, and `Number(req.search.get("limit"))` is the exact
> shape that breaks — `?limit=1.5` is a URL anybody can type or a client can compute, and nothing
> between the request and the statement narrows it. `page` is the harder one to find, because it
> never reaches the ORM at all: it reaches it **multiplied**, as a fractional `skip`, so the refusal
> names an argument the call site never wrote and points at a line that only does arithmetic.

[`paginate`](#paginate) below is the request-facing half of that rule: it takes the query string as
it arrives and cannot produce a value this section refuses.

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

### `paginate`

The integer rule above is a refusal; this is the spelling that satisfies it, short enough that
reaching for it is easier than reaching for `Number`:

```ts
import { paginate } from "gemi/orm"

const { take, skip } = paginate({
  page: req.search.get("page"),
  perPage: req.search.get("perPage"),
})

await Post.findMany({ take, skip, orderBy: { createdAt: "desc" } })
```

```ts
paginate(
  args: { page?: unknown; perPage?: unknown },
  options?: { perPage?: number; maxPerPage?: number },
): { take: number; skip: number }
```

**Both arguments are `unknown` deliberately.** A query string is where these values come from —
that is the whole point of the helper — and typing them as `number` would mean every caller writes
the `Number(…)` that is the bug. `req.search.get` hands back `string | string[]`, and a repeated
key is a case `Number` honours sometimes and not others: `Number(["2"])` is `2`, while
`Number(["1", "2"])` is `NaN`.

The rules, each of them a shape a real request produces:

- Anything that is not a string or a number is **absent** — an array, an object, a boolean, `null`.
- An empty or blank string is absent as well, rather than `0`. `Number("")` is `0`, and `page: 0`
  computes `skip: -25`, so a cleared filter box would otherwise be a 500.
- A non-finite value is absent. `Number("1e400")` is `Infinity`, which `Math.trunc` cannot repair.
- What is left is truncated toward zero — the same direction Prisma truncates a fractional `take`,
  so a call site moving off Prisma keeps the same page instead of trading a crash for a different
  answer — with `page` clamped up to at least 1 and `perPage` clamped into `[1, maxPerPage]`.

The defaults are **25 rows a page** and a ceiling of **100** on what a *request* may ask for, so
`?perPage=100000` cannot ask for the whole table. An endpoint that genuinely serves larger pages
says so where it is called, `paginate(args, { maxPerPage: 500 })`, which is one visible decision
instead of an invisible default. `skip` is capped at `Number.MAX_SAFE_INTEGER`: `?page=1e300`
survives every rule above and multiplies out past what either driver will bind.

**The guarantee is the reason to import this rather than copy it.** Every return value is a pair of
integers with `take >= 1` and `skip >= 0`, for every input — so `paginate`'s output cannot be a
value the integer rule refuses. `Number(x) || 1` does not have that property: it
rescues `?page=` and `?page=0`, which are falsy, and passes `?page=-1`, `?page=2.5` and
`?page=1e400` straight through to a refusal.

`bunx gemi migrate` annotates every `take:` and `skip:` under `app/` whose value is not provably an
integer, which is how you find the call sites in an application already written — see
[the CLI page](./cli.md).

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
  It compiles to `count(field)`, which counts the rows where `field` is not null — for the size of
  the group, which is what `_count: true` returns, order by `_count: { _all: "desc" }` instead. On a
  non-nullable column the two agree; on a nullable one they disagree exactly where nobody checks.
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

### JSON path filters

```ts
// postgres
await User.findMany({ where: { metadata: { path: ["plan"], equals: "pro" } } })
// sqlite
await User.findMany({ where: { metadata: { path: "$.plan", equals: "pro" } } })
```

**The path grammar differs by dialect, and that is Prisma's split rather than this ORM's.** Its
generated client takes an array of keys on Postgres and a JSONPath string on SQLite, and refuses the
other form on each — so the argument is dialect-specific before it reaches gemi. The refusal here
says which form the database you are on wants.

Which filters apply also differs, again following Prisma:

| | SQLite | Postgres |
| --- | --- | --- |
| `equals`, `not` | yes | yes |
| `string_contains`, `string_starts_with`, `string_ends_with` | yes | yes |
| `array_contains` | no | yes |
| `lt`, `lte`, `gt`, `gte` | no | yes |

Prisma refuses the bottom two rows on SQLite with *"Unknown argument"*, so gemi refuses them too:
implementing them there would answer a query the differential harness has no oracle for.

**The path is always a bound parameter.** It is the one place a caller's value decides part of an
expression's meaning, and both dialects take it natively — Postgres's `#>` accepts a `text[]`,
SQLite's `json_extract` a string — so the feature fits inside invariant 2 rather than bending it.

Three things a path filter refuses, each because answering would be silently wrong rather than
merely unsupported:

- **The null sentinels.** `{ path: […], equals: DbNull }` is refused. An extracted value
  cannot tell an absent key from a JSON `null` — `#>>` yields SQL NULL for both — so the
  distinction the sentinels exist to make is already gone by the time the comparison happens.
  Filter the column itself: `{ metadata: { equals: DbNull } }`.
- **A non-string operand to `string_contains` / `string_starts_with` / `string_ends_with`**, for
  the same reason the scalar `contains` refuses one: the pattern would become `%null%`, which runs
  and returns the wrong rows.
- **An object or array under `equals` / `not` / the numeric comparisons.** Prisma accepts one;
  gemi does not yet. It would bind as `"[object Object]"` on Postgres and match nothing. Use
  `array_contains` for containment, or narrow the path until it names a scalar.

An empty path — `[]` or `""` — is refused on both dialects. On Postgres it would extract the whole
document, which is a filter on the column rather than on a path.

**What the type checks, and what it leaves to run time.** The path filter is typed: `path` takes
either dialect's grammar, the ten operators are the ones above, and their operand types are the
ones the compiler will compile. A misspelled operator, a `path` that is not one, a non-string under
`string_contains` and a sentinel at a path are all compile errors. The type carries no dialect —
the generated artifact does not know which database it will be pointed at — so the table above is
offered in full on both and the wrong half is refused at run time, naming the dialect. The empty
path is refused at run time too.

One consequence worth naming: a JSON document with a **top-level `path` key** cannot be written as
the bare-value shorthand, because `path` is what tells the compiler the operand is a path filter.
It never could — `{ metadata: { path: "/a" } }` reached the path compiler and raised — and now says
so at compile time. Write the document explicitly: `{ metadata: { equals: { path: "/a" } } }`.

### Scalar lists (Postgres only)

```ts
// model Post { tags String[] }
await Post.findMany({ where: { tags: { has: "urgent" } } })
await Post.findMany({ where: { tags: { hasEvery: ["urgent", "draft"] } } })
await Post.update({ where: { id }, data: { tags: { push: "urgent" } } })
```

**Postgres only, and that is Prisma's line rather than this ORM's.** SQLite has no array type, and
`prisma generate` refuses the column outright there — *"Field `tags` in model `Post` can't be a
list. The current connector does not support lists of primitive types."* So there is no SQLite
behaviour to match.

The filters, which are a **different set from the scalar operators** on a different kind of column:

| | |
| --- | --- |
| `has` | the list contains this element |
| `hasEvery` | the list contains all of these |
| `hasSome` | the list and this one share an element |
| `isEmpty` | `true` or `false` |
| `equals` | the whole list, in order |

`contains`, `startsWith`, `in` and the comparisons are **not** among them: `contains` on a `String`
asks about a substring, and on a `String[]` there is no such question — the one Prisma spells is
`has`. Writing one gets an error naming both sets.

One asymmetry worth knowing before it surprises you, because it is Prisma's and gemi reproduces it:

```ts
await Post.findMany({ where: { tags: ["a", "b"] } })      // ✗ refused
await Post.findMany({ where: { tags: { equals: ["a", "b"] } } })  // ✓
await Post.update({ where: { id }, data: { tags: ["a", "b"] } })  // ✓ a bare array is a value
```

A bare array is a **value** but not a **filter**. Prisma rejects the first line with *"Expected
StringNullableListFilter"*, so gemi does too rather than guessing that `equals` was meant.

Writes take `set` and `push`; `push` accepts one element or a list. `increment` and its siblings
apply to a number, not to a list of them, and are refused by name.

**An omitted list is written as the empty list, not refused.** A `String[]` with no `@default` is
still not "missing" on `create` — Prisma writes `[]`, and so does gemi. That was measured against a
generated client rather than read off the input type, which says only that the field is optional.

Every element type Prisma allows is supported — `String`, `Int`, `Float`, `Boolean`, `BigInt`,
`DateTime`, `Bytes`, `Json` and enums. `Decimal[]` is refused, because `Decimal` itself is (see
below); a list of a scalar no dialect can round-trip is not more supportable for being a list.

An enum list is worth one note: the driver hands those back as an unparsed Postgres array literal
rather than as an array, so gemi parses them. You will not see the difference — that is the point —
but it is why a list column costs a decode where a `String` does not.

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
either way, and there are tests asserting exactly that against Prisma across every relation shape
in the differential corpus — **48** of them today, and the suite fails if this number stops
matching the corpus.

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
| `create` | Writes new related rows. One statement each. On a **to-one that already has a child** the new row takes the link and the old one is detached — orphaned, not deleted. |
| `createMany` | The same rows in **one** statement. To-many only, and the rows go inside `data`. |
| `connect` | Points at an existing row — a bound column when it names the referenced key, a lookup otherwise. On a **to-one that already has a child** it displaces the incumbent, as `create` does. |
| `connectOrCreate` | Looks the row up by a unique key and creates it only if it is not there. **A hit ignores `create` entirely** — it is connect-*or*-create, not upsert. |
| `disconnect` | Clears the link. A unique key, or a list of them, on a to-many; `true`, `false` or a filter on a to-one, whichever side holds the key. The column that goes null is on whichever side holds it, and it has to be nullable. |
| `delete` | Deletes the named rows outright, not just the link. A unique key or a list of them on a to-many; `true`, or a filter, on a to-one whose child holds the key. |
| `update` | Writes your columns to the named row. The child's own `onUpdate` and scope rules apply to the payload. |
| `set` | Replaces the whole set — detaches what is linked now, attaches what you name. |
| `updateMany` | Writes your columns to this parent's rows matching a filter. |
| `deleteMany` | Deletes this parent's rows matching a filter — the filter goes directly under the key, not inside a `where`. |
| `upsert` | Finds the row **among this parent's**, updates it, or creates it. A to-one has no `where` to require — the link already names the row. |

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

A child whose policy *scopes on the foreign key itself* — `scope: () => ({ folderId: mine })` — can
still use the relation operands that write that key. `connect`, `disconnect` and the rest go
through without an `onUpdate`, because the scope-escape guard judges **the columns you supplied**
rather than the ones the nested step put there: the ORM records which columns it wrote and exempts
those from the check.

The exemption is provenance, not permission. A column *you* name is refused exactly as before —
writing `folderId` yourself on a model scoped by it is still a scope escape, and still needs an
`onUpdate` to say so deliberately.

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
`update: { data: { … } }`, because Prisma accepts both — measured on the side that holds the key,
and again on the side whose child holds it, since the two are separate input types in the generated
client and only one of them had been checked.

A to-one `update` may also carry a `where`, and it does not mean what the to-many's means. There is
nothing to choose between, so the filter decides *whether the single linked row is written at all*:
`update: { where: { status: "draft" }, data: { … } }` writes the child if it is a draft, and raises
if it is not. That raise is the part to know — a filter that matches nothing is a miss, reported
with the same error and the same wording as a parent that has no child at all, because Prisma
answers both with P2025 and does not distinguish them either.

`set` is the one supported operand that acts on rows you did **not** name, so it means *replace the
set I can see*: it detaches the linked rows your policies let you read, and leaves the rest attached.
With no policy on the child that is Prisma's `set` exactly. Two of its behaviours are worth knowing
because the name does not suggest them — it will repoint a row belonging to another parent, exactly
as `connect` does, and it silently ignores a named row that does not exist.

**Writing onto a to-one that already has a child displaces it.** The new or newly-linked row takes
the link and the incumbent is left in the table with a null foreign key — detached, not deleted,
which is Prisma's answer and the one worth stating because deleting would be the silent version of
the same call. What can be displaced is what your policies let you see: an incumbent hidden from you
is not detached, and the write then collides with it on the child's unique key.

Which operands displace is Prisma's, measured rather than derived, and it is not "everything that
ends with a child pointing here":

| operand | on an occupied to-one |
| --- | --- |
| `create` | displaces the incumbent |
| `connect` | displaces the incumbent |
| `connectOrCreate`, hit | displaces — it *is* a connect |
| `connectOrCreate`, miss | collides on the child's unique key |
| `upsert`, create branch | collides on the child's unique key |

So the two branches of one `connectOrCreate` answer differently: linking an existing row displaces,
and the `create` *inside* a compound operand does not, though a bare `create` does.

One gap remains, on the other side of the key: pointing **this** row at a partner who already has
one — `Profile.update({ data: { user: { connect: { id } } } })` where that user's profile is taken —
collides here and displaces in Prisma. Detach the incumbent first, or write the foreign key
directly.

**On a to-one, `disconnect` and `delete` take `true` or a filter — and `false` is a no-op rather
than a synonym for `true`.** There is one row and nothing to name, so `true` is how you say *the
one that is linked*. A filter narrows rather than picks: `delete: { status: "draft" }` acts only if
that single row matches, and it is a filter and not a unique key, so a column with no unique index
is accepted here — Prisma accepts one, and refusing it would refuse a query the client answers.
`false` is the value nobody guesses, and it is the reason to say this out loud: it writes nothing at
all, so `disconnect: shouldDetach` leaves the row alone on the branch that asked for nothing.

The two operands then part company on a miss, still on a to-one, and it is Prisma's asymmetry rather
than a choice gemi made: `delete` raises `RecordNotFoundError` when there is no row to delete, while
`disconnect` is silent. That holds whichever way the row went missing — no child linked at all, or a
child present that the filter does not match, or a child your policies hide, which reads as no row
at all here exactly as it does everywhere else. Note the last one carries a different error from its
to-many spelling, which reports a hidden row as *not connected*.

**All three arms work on either side of the key**, and the side that holds it reaches them
differently. Where the key is on the row you are writing, `true` is one bound column set to null and
costs nothing; `false` writes nothing at all; a filter has to read the linked row before it can
decide, so it costs a lookup — and that lookup goes through the far model's own policies, which
means a linked row you cannot see reads as one that does not match and the link survives. `true` has
no lookup to scope, so it clears the column either way. That difference is worth knowing before you
reach for the filter to enforce something: it narrows *whether* the detach happens, and a policy can
narrow it further.

One divergence, and it is deliberate. On a **many-to-one** — a to-one whose other side is a list —
Prisma ignores this operand's value: `disconnect: false` and a filter matching nothing both clear
the key, though the generated input type is the same `WhereInput | boolean` it honours on a
one-to-one. gemi answers one grammar the same way on both shapes, because the behaviour to match is
a silent write on the call that asked for nothing. So `disconnect: shouldDetach` is safe here and is
not safe through the Prisma client.

**An array is refused on a to-one whose child holds the key** — `create`, `connect`,
`connectOrCreate`, `update`, `delete` and `upsert` alike — and that is matching Prisma rather than
being stricter than it. All of them are a `PrismaClientValidationError` against a generated client,
with nothing written. Because that is an *argument* refusal and carries no Prisma error code, gemi's
is `InvalidArgumentError`, and the message names the single object the operand wants rather than
announcing that arrays are unimplemented. What made it worth refusing rather than tolerating: the
array used to compile, and a `connect` of two rows through a relation that holds one repointed
**both**, the second silently winning. `connect` and `connectOrCreate` refuse an array on the other
side too, and always did.

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

On a to-one there is no `where` to require, because the link already names the row — so
`upsert: { create, update }` is the whole operand and the `update` branch runs against the single
child. A `where` is still accepted, and it is the same sentence seen from the other side: one that
does not match takes the **create** branch, and the create then collides with the unique foreign key
the existing child is holding. That collision is a `UniqueConstraintError` and it is left to happen
rather than pre-empted, because it is the answer Prisma gives.

The same collision is how a *hidden* child surfaces, which is worth knowing before you meet it: a
row your policies scope away reads as absent, absent takes the create branch, and the create runs
into the unique key the row you cannot see is holding. So a to-one `upsert` can fail on a field the
caller never wrote — the child's foreign key — and that is the shape of the answer, not a leak: it
is the same refusal an unrelated row holding that key would produce.

Every operand in Prisma's nested grammar is implemented for an ordinary relation — one that is not
an implicit many-to-many — in the direction where the **child** holds the foreign key. That is every
to-many, and a to-one read from the side the child points at. Ones that act on rows already linked
to this one — `disconnect`, `delete`, `update`, `updateMany`, `deleteMany`, `set`, `upsert` — are
available on an `update` and refused on a `create`, which has nothing linked to it yet; Prisma
reports them as unknown arguments there too.

**Two are refused on a to-one that holds its own key, and both are decisions rather than unfinished
work.** `delete` there would remove a row the statement is not about — the far row lives in another
table and is reached through a column of this one, and a delete firing as a side effect of an
unrelated update is the kind of thing to implement deliberately or not at all. `upsert` would have
to create the far row and then write its key back to a parent that has already been inserted, a
shape no other operand on that side needs. Both refusals name the alternative: write the far row
directly, then `connect` it. (`set`, `updateMany` and `deleteMany` describe *several* rows, so
neither side of a to-one offers them, and neither does Prisma.)

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

### Saying where nulls go

```ts
await User.findMany({ orderBy: { email: { sort: "asc", nulls: "last" } } })
await User.findMany({ orderBy: [{ id: "desc" }, { email: { sort: "asc", nulls: "first" } }] })
```

`nulls first` / `nulls last` is emitted directly on both dialects. Prisma writes a
`CASE WHEN … IS NULL` expression on SQLite instead, which dates from before SQLite 3.30 — it has
understood the standard syntax since, and Bun bundles a newer one.

**The two dialects disagree by default, so this is not cosmetic.** Postgres sorts nulls above every
non-null; SQLite sorts them below. The same `orderBy: { email: "asc" }` therefore returns
`[1, 2, null]` on Postgres and `[null, 1, 2]` on SQLite — measured on both, not inferred — so a
query moved between them changes its answer with nothing to notice. Saying `nulls` is what makes
the ordering mean the same thing on either database.

It is worth saying even on one dialect. The default that makes `asc` put nulls last on Postgres
makes `desc` put them first, so an ordering that was correct by accident stops being correct the
moment someone flips the direction. A negative `take` flips the placement along with the direction,
so a reversed page keeps the intent too.

The long form works wherever a direction does, including through a relation:
`orderBy: { accounts: { _count: { sort: "desc", nulls: "last" } } }`.

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

### Unit-testing code that opens one

`Model.transaction` resolves its connection ambiently, out of the `AsyncLocalStorage` scope — which
is exactly what lets `audit(user)` above join the transaction without being handed anything. The
same property means there is no client to inject: a unit test of a function that crosses a
transaction has to either boot a Kernel or replace the model module.

Replacing the module is usually what you want, because the point of the test is the branching
around the write rather than the SQL:

```ts
import { vi } from "vitest"

vi.mock("@/app/models", () => ({
  User: { create: vi.fn(), findFirst: vi.fn() },
  transaction: (cb: () => unknown) => cb(),   // run the callback, open nothing
}))
```

`transaction: (cb) => cb()` is the whole trick: the callback runs inline, the assertions are about
what it called, and no connection is involved. `vi.spyOn` on the model statics does the same job
when you want the real module for everything else.

**A mocked failure has to reject with the error the runtime really throws**, and this is the one
place a mock can certify a branch that no longer exists. `create.mockRejectedValue({ code: "P2002" })`
is the object a Prisma application already has lying around; against gemi it satisfies nothing —
the guard under test is `isUniqueConstraintError`, that object is not one, so the recovery branch is
never entered and the test passes anyway, having asserted the fallthrough. Construct the real error
instead:

```ts
import { UniqueConstraintError } from "gemi/orm"

User.create.mockRejectedValue(new UniqueConstraintError("User", "create", ["email"]))
```

The cost of getting this wrong is measured rather than imagined: in the first application ported
onto this ORM, four `code === "P2002"` guards went dead when their writes moved over, roughly 2,700
unit tests stayed green throughout, and what caught it was a person reading the diff.

What this does not cover is the behaviour that only a real transaction has — the rollback, the
savepoint, the Postgres abort described above. Those need a database, and they belong in an
integration test rather than in a mock. Keep the seam for the control flow and test the transaction
itself against Postgres.

## Connections

One connection is the default and needs no configuration. A second one is for the case where two
workloads share a database and want opposite settings from it — a hot path that must never block,
and an analytics path whose queries legitimately run for seconds:

| | hot path | analytics |
| --- | --- | --- |
| pool max | 12 | 3 |
| statement timeout | 8s | 45s |

A value that protects one of those is the wrong value for the other, which is the whole reason they
cannot be one pool with one setting. Without a second connection, a dashboard aggregate can drain
the pool and block sign-in.

The top-level `url` and `options` describe the connection called `default`. Everything else goes
under `connections`:

```typescript
// app/config/database.ts
export default defineDatabaseConfig({
  url: process.env.DATABASE_URL,
  options: { max: 12 },

  connections: {
    analytics: {
      url: process.env.DATABASE_URL,          // the same database, deliberately
      options: { max: 3, idleTimeout: 60 },   // a pool of its own
      slowTransactionThreshold: 60_000,       // and a threshold that suits it
    },
  },
})
```

The same URL twice is normal and is not a mistake: what differs is the pool, not the database.
`url` and `options` are never inherited from the top level — a connection that borrowed the
default's URL by omitting one would be a second pool created by a typo — but
`slowTransactionThreshold` is, since it is a diagnostic that applies to any pool.

### Naming one, per query

```ts
const rows = await Subscription.on("analytics").findMany({ where })
const raw = await DB.connection("analytics").query(sql`select …`)
```

**Which connection a model uses is a per-query property, not a per-model one.** The same
`Subscription` is read on the hot path during sign-in and swept by the nightly audit, so a
`connection` declared on the model class would force one of those two to be wrong. `on` returns the
model class with the connection bound to it, so the whole typed surface is there and narrows exactly
as it does on the class itself.

The connection reaches everything that query fans out into — the nested reads of an `include`, the
extra statements of a nested write, the relation reads a `_count` compiles — because it travels in
the same ambient scope the transaction does. There is no argument to forget to pass on.

An unknown name raises `UnknownConnectionError` and lists the ones that are configured. It never
falls back to the default: `Subscription.on("analitycs")` running on the hot path is the exact
incident the second pool was configured to prevent, and it would arrive weeks later with nothing
pointing at the typo.

`query`, `execute` and `transaction` on a handle *reject*, so a `.catch()` catches a wrong name or a
refusal. The `sql` and `dialect` getters have nowhere to put a rejection and throw synchronously
instead — and `DB.connection(name).sql` is Bun's raw template, so it runs on that connection's
**pool** rather than on an open transaction, exactly as `DB.sql` always has. Use `query` and
`execute` when the difference matters.

A `save` writes back to the connection its row was read on, since a tracked row outlives the scope
that produced it — see [Rows & entities](./orm-rows-and-entities.md).

### A transaction cannot span two connections

This is the constraint to design around, and it is enforced rather than documented:

```ts
await Model.transaction(async () => {
  await Invoice.create({ data })
  await Subscription.on("analytics").findMany({})   // CrossConnectionTransactionError
})
```

A transaction lives on one reserved connection of one pool. A statement on another pool cannot join
it and cannot be rolled back with it, so the alternatives to raising are both worse: run it outside
the transaction and it stays committed when the transaction rolls back; run it on the open handle
and it goes to the wrong database, which is usually a table of the same shape and no error at all.

Catching the error leaves the transaction usable, so the fix is local — move that query outside the
transaction, or do the whole unit on one connection.

Inside a transaction, a query that does **not** name a connection joins it, whichever connection it
was opened on:

```ts
await DB.connection("analytics").transaction(async () => {
  await Digest.create({ data })    // on "analytics", inside the transaction
})
```

### What a second connection costs

Every connection is a real pool, counted separately against whatever limit the server or the pooler
enforces. Two pools of 12 is 24 connections, not 12 — so split the budget rather than adding to it,
the same arithmetic as [running a Prisma client alongside gemi](#setup). `DB.close()` closes all of
them.

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
static $policies: AccountPolicy[] = [softDeletes<typeof Account>(), new TenantPolicy()]
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
  this is the gap the guarantee genuinely has. `Kernel.models` closes it for the modules you
  declare, and `gemi check models` closes it for the files you forgot to declare.

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
  static $policies = [softDeletes<typeof User>()]  // reads skip rows with a deletedAt
  static expire = softDelete(User)                 // an update that sets deletedAt
  static expireMany = softDeleteMany(User)
}
```

> **`expire`, not `delete`, and that is a limitation rather than a style.** Naming the wrapper
> `delete` would be the better recipe — `User.delete()` would transparently become an update — and
> it cannot be written: the member's type would have to be read off the class the member is being
> defined on, which TypeScript refuses with *"'delete' implicitly has type 'any' because it does
> not have a type annotation and is referenced directly or indirectly in its own initializer"*.
> Annotating it does not help, and passing the generated base instead of your subclass breaks the
> feature, because policies are resolved per registered class and the base carries none.
>
> **So `User.delete()` remains a hard delete.** On a model that soft-deletes, that is a real edge:
> reads are scoped by the policy, but a `delete` still removes the row. Call `User.expire()`, and
> if a hard delete should be unreachable, keep the model's `delete` behind a policy of your own.

`deletedAt` must be a nullable `DateTime` on the model (`field` overrides the column name). The
read half applies to nested reads for the same reason every policy does — a deleted `Account` does
not appear under `User.findMany({ include: { accounts: true } })` without anything being written at
the include site, which is the half ORM-level soft deletes usually get wrong.

Composing it with your own is one list:

```ts
static $policies: UserPolicy[] = [softDeletes<typeof User>(), new TenantPolicy()]
```

`softDeletes()` carries an `onUpdate` pass-through, because `softDelete()` writes the very column
the policy scopes on and something has to say that is intended. That permission is **per policy**:
a tenant policy sitting beside it in the same list still has to answer for its own column.

`field` is constrained to the model's **schema columns** — the same list `UnknownFieldError` prints
— on every spelling that names a model:

```ts
softDeletes<typeof User>({ field: "archivedAt" })   // checked
softDelete(User, { field: "archivedAt" })           // checked
softDeleteMany(User, { field: "archivedAt" })       // checked

softDeletes({ field: "archivedAt" })                // unchecked — no model named
```

Columns rather than keys is the part that matters: the constraint used to be `keyof` the *instance*
type, so `field: "save"` — a method — compiled clean and failed at runtime. Pass the model as
`typeof User` and it is a compile error.

Nothing needs spelling twice. If you override the default, each call checks its own argument:

```ts
export class User extends UserModel {
  static $policies = [softDeletes<typeof User>({ field: "archivedAt" })]
  static expire = softDelete(User, { field: "archivedAt" })
}
```

## Errors

Every failure is a typed error from `gemi/orm`, not a driver string.

| Error | Raised when |
| --- | --- |
| `RecordNotFoundError` | An `…OrThrow` operation matched nothing. |
| `UniqueConstraintError` | A unique constraint was violated, with the constraint identified. It is gemi's own error and carries no Prisma `code` — see below if a `"P2002"` check is what you have today. |
| `PolicyDeniedError` | A `before` denied, or `ctx.user` was read with no user. |
| `ScopeEscapeError` | An `update` wrote a column its own policy's `scope` selects on, with no `onUpdate`. |
| `UnknownFieldError` / `UnknownRelationError` | A name that is not on the model. |
| `UnsupportedQueryError` | A query shape the compiler does not implement — with what and why. |
| `ModelNotRegisteredError` / `UnregisteredPolicyClassError` | Registry problems (see [Setup](#your-model-class)). |
| `AmbiguousModelRegistrationError` | `registerModels` found two unrelated classes in one module claiming the same model, and refused to pick (see [Setup](#your-model-class)). |
| `RelationDepthExceededError` | An include tree past `MAX_RELATION_DEPTH`. |
| `ParameterLimitError` | A statement exceeding the dialect's parameter ceiling. |
| `MissingRequiredValueError` | A write leaving a required column with no value and no default. |
| `DecodeError` | A column the driver returned that cannot be read as its declared type. |
| `UnsupportedByDesignError` | A subclass of `UnsupportedQueryError` for the arguments under [Not in scope](#not-in-scope) — it says *decision*, where the parent says *not yet*. Catch this one to tell them apart. |
| `InvalidArgumentError` | The other subclass: the argument exists and the *value* cannot mean anything — `take: "-2"`. Says what a good value looks like, rather than that the argument is unsupported. |
| `UnsupportedDialectError` | A model operation on a dialect with no compiler — MySQL and MariaDB. See [Dialects](#dialects). |
| `UnknownConnectionError` | A connection name that is not configured, listing the ones that are. Never a fall back to the default — see [Connections](#connections). |
| `CrossConnectionTransactionError` | A statement naming one connection while a transaction is open on another. Both are named; the fix is to move that query outside the transaction. |
| `ReturningUnsupportedError` | A write on a dialect without `RETURNING`, which is the same gap seen from the write path. |
| `StaleSchemaArtifactError` | Generated files predate the running gemi. Re-run `prisma generate`. |
| `MalformedRelationError` / `MissingModelSchemaError` / `UnregisteredRelationTargetError` | The generated artifact and the registry disagree — the same family as the two above, and the same fix. |

**`isUniqueConstraintError` is the guard to write in a retry-on-collision `catch`**, which is where
a unique-violation check almost always is. It is exported from `gemi/orm` beside the class itself:

```ts
try {
  return await Invite.create({ data: { token } })
} catch (error) {
  if (!isUniqueConstraintError(error)) throw error
  return await Invite.findUniqueOrThrow({ where: { token } })
}
```

```ts
isUniqueConstraintError(error: unknown): error is UniqueConstraintError
```

It tests `instanceof` **or** `error.name === "UniqueConstraintError"`, and the second half is the
reason to import it rather than write `instanceof` yourself. `instanceof` compares against *this*
module instance's class object, so it is false across a duplicate copy of `gemi/orm` — two versions
in one dependency tree, a bundled build beside a linked one, a monorepo package resolving its own.
The error would be the right error, thrown by the right code, and the guard would silently not fire.
Every error here sets its own `name` for exactly that reason.

> **Porting from Prisma: this is the check that dies quietly.** A collision arrives as
> `UniqueConstraintError`, which names `model`, `operation`, `fields` and `constraint` and has no
> `code` anywhere on its prototype chain. So `error.code === "P2002"` is `false` from the moment the
> write it guards moves onto the ORM — nothing raises, nothing is logged, and the recovery branch
> the guard exists to run never runs again. It compiles, it runs, and it reads correct. Go and find
> the string rather than waiting to meet it: `bunx gemi migrate` annotates the occurrences it can
> see (see [the CLI page](./cli.md)), and
> [UPGRADE.md](https://github.com/nstfkc/gemi/blob/main/UPGRADE.md) carries the two-armed bridge to
> write while some of your writes are still on Prisma, with the marker saying when to delete it.

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

## Enums

A Prisma `enum` is a **string** at runtime, on both dialects, exactly as it is through Prisma:

```ts
await Organization.findMany({ where: { plan: { in: ["pro", "enterprise"] } } })
```

The generated schema records the enum's name beside the field, but the value you write and the
value you read back are the plain member name. Equality, `not`, `in`, `orderBy` and `groupBy` all
work on it and are compared against Prisma by the differential suite.

One consequence worth stating, because it is the one thing that surprises: **`orderBy` on an enum
sorts differently on the two dialects.** Postgres creates a real enum type and sorts by
*declaration* order; SQLite stores the member as `TEXT` and sorts *alphabetically*. For
`enum OrganizationPlan { free pro enterprise }`, measured:

```
postgres   free, pro, enterprise      (declaration order)
sqlite     enterprise, free, pro      (alphabetical)
```

gemi matches Prisma on each dialect rather than inventing a uniformity Prisma does not have — the
same call as `contains` being case-sensitive on Postgres and not on SQLite. If you need one order
everywhere, sort in the application or store an explicit rank column.

## `Json` columns

A `Json` column round-trips whatever you give it: an object, an array, a string, a number, a
boolean. The value is stored as JSON and comes back as the same JavaScript value, on both
dialects and whether it is read at the root or nested inside an `include`.

Two things are worth knowing:

- **A string is a string.** `metadata: "42"` stores the JSON string `"42"`, not the number, and
  `metadata: '{"a":1}'` stores that text as a string rather than as an object. If you want an
  object, pass an object.

- **Empty is two values, and you have to say which.** `metadata: null` does not type-check,
  because a `Json` column has two distinct empty states and guessing between them is what the
  sentinels exist to prevent:

  ```ts
  import { DbNull, JsonNull } from "gemi/orm"

  await User.create({ data: { …, metadata: DbNull } })    // the column is SQL NULL
  await User.create({ data: { …, metadata: JsonNull } })  // the column holds JSON null
  ```

  These used to be spelled `Prisma.DbNull` and `Prisma.JsonNull`, which made this the one piece of
  ordinary application code that could not be written without `@prisma/client`. gemi has always
  recognised the sentinels structurally rather than by identity — that is why the ORM runtime could
  stay free of Prisma at all — so Prisma's own still work if you have them.

  Both read back as `null`, so the difference is invisible from JavaScript and entirely visible to
  anything else that reads the column — `psql`, a report, Prisma itself. Filtering takes the same
  pair, and takes them as an explicit comparison:

  ```ts
  await User.findMany({ where: { metadata: { equals: DbNull } } })   // the SQL NULLs
  await User.findMany({ where: { metadata: { equals: JsonNull } } }) // the JSON nulls
  ```

  A bare `where: { metadata: DbNull }` raises `InvalidArgumentError` naming the explicit
  form. Prisma rejects that spelling too, so this is parity rather than a gemi restriction.

  There is a **third** sentinel, and it belongs only in a filter:

  ```ts
  import { AnyNull } from "gemi/orm"

  await User.findMany({ where: { metadata: { equals: AnyNull } } })  // both kinds at once
  await User.findMany({ where: { metadata: { not: AnyNull } } })     // neither kind
  ```

  `AnyNull` asks for *either* empty state, which is usually what you want when you do not
  care how the row got that way — it compiles to `is null or = 'null'`, one predicate rather than
  an `OR` you assemble yourself. It is a question about rows rather than a value, so writing it
  raises `InvalidArgumentError`, and so does using it under any operator other than `equals` and
  `not`. Prisma refuses all three of those too.

On Postgres the parameter is cast — `$1::text::jsonb` — and the value serialised to match, which
is what lets a bare number or boolean through. Binding it raw makes the driver send an `integer` to
a `jsonb` column, and serialising *without* the cast stores the jsonb string `"42"` instead of the
number, which is worse than refusing it. SQLite needs neither: it stores JSON as text.

> **Upgrading:** `Json` values written by a *pre-release* build of this ORM on Postgres were stored
> as JSON **strings** rather than as objects — `{ a: 1 }` landed as `"{\"a\":1}"`. Reads undid it,
> so nothing looked wrong from inside the ORM, but the column was wrong for anything else that read
> it. Those rows now read back as strings. Re-seed development databases; there is no released
> version affected.

## Run Postgres deployments with `TZ=UTC`

**A deployment requirement, not a preference.** Prisma maps `DateTime` to `timestamp(3)` — no time
zone — and stores UTC in it. Bun's driver decodes that column differently depending on which wire
protocol carried the statement, and *which protocol is used depends on whether the query binds a
parameter*:

```ts
await User.findMany()                      // no parameters -> simple protocol
await User.findMany({ where: { id } })     // one parameter -> extended protocol
```

The first comes back as zoneless text and is parsed as **local** time; the second comes back in
binary and is correct. Same row, same column, two different instants — off by your machine's UTC
offset. Measured against Postgres 16:

```
TZ=UTC                no parameters -> 2021-03-04T05:06:07.008Z    where id = $1 -> 05:06:07.008Z
TZ=America/New_York   no parameters -> 2021-03-04T10:06:07.008Z    where id = $1 -> 05:06:07.008Z
```

Set `TZ=UTC` on any process that talks to Postgres and both paths agree. This is the setting the
test suites and CI already run under.

The ORM cannot correct it below the query: the decoded value alone does not say which protocol
produced it. SQLite is unaffected — it stores `DateTime` as milliseconds and there is no text
representation to reinterpret.

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
- **No `Decimal`, on either dialect.** Refused at `prisma generate` rather than at query time — see
  [Columns the generator refuses](#columns-the-generator-refuses). SQLite stores it as a REAL and
  hands back a JS number, so the value would be a float typed as `Prisma.Decimal`. `Decimal[]` is
  refused for the same reason.
- **Scalar lists are Postgres-only**, which is not a gemi limit but Prisma's: SQLite rejects the
  column at schema validation. They are otherwise fully supported — see
  [Scalar lists](#scalar-lists-postgres-only).

Both of the last two throw `UnsupportedByDesignError`, which says *"and this is a decision rather
than a gap"* rather than *"yet"* — so a refusal you can plan around reads differently from one that
might lift next release.

## See also

- **[Rows and entities](./orm-rows-and-entities.md)** — POJOs, `track` + `save`, and `wrap`.
- **[Authentication](./authentication.md)** — `app/config/auth.ts` and the user provider.
  `UserProvider` (exported from `gemi/kernel`) implements all twenty-two methods of the auth
  persistence on this ORM, and is the only implementation: the adapter seam and the Prisma
  adapter are gone, and `AuthManager` constructs it directly. It resolves your models from the
  registry by name, so registering them at boot is what makes sign-in work.
- **[Authorization](./authorization.md)** — route-level authorization, which policies complement
  rather than replace.
