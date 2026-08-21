# Upgrading from 0.55 to 0.56

One change, and it is a deletion. **Do it as part of the upgrade** — leaving the
old wiring in place is not a no-op, it stops your project typechecking.

## Delete `gemi.d.ts` and its `tsconfig.json` entry

Your app root has a `gemi.d.ts`, and your `tsconfig.json` has a `types` entry
naming it:

```jsonc
// tsconfig.json
"types": ["vite/client", "bun", "./node_modules/gemi/gemi.d.ts"]
```

Delete both. The file:

```bash
rm gemi.d.ts
```

and the entry, leaving your own toolchain behind:

```jsonc
"types": ["vite/client", "bun"]
```

That is the whole migration. `gemi/client` and `gemi/facades` now reference the
augmentation themselves, so importing from either is all it takes to get
`useQuery`, `Link`, `Form`, `Query` and the rest typed against your routes.
Nothing replaces the deleted file.

**Why it is not optional.** Both of those named
`./node_modules/gemi/gemi.d.ts`, and the augmentation now ships at
`node_modules/gemi/dist/gemi.d.ts` instead. An unresolvable `types` entry is a
configuration error that `tsc` reports *instead of* compiling:

```
error TS2688: Cannot find type definition file for './node_modules/gemi/gemi.d.ts'.
```

and you get that one line and no other diagnostics, on 0.56 exactly as on 0.55.

**If it was already broken, this is the fix.** That path never resolved in a
published install — `gemi.d.ts` was not in any tarball before 0.56 — so if
`useQuery("/your/route")` has never typechecked outside this repository, or your
CI typecheck has been failing on TS2688, deleting these two things is what
repairs it rather than what breaks it.

---

# Upgrading from 0.50 to 0.51

Three changes need a hand, and the third is a look rather than an edit — it only
becomes work if you were using an unlisted job as an off switch. `bunx gemi
migrate` does none of those three for you; it is the 0.42→0.43 tool, and all
three are decisions a codemod cannot make.

Two more sections follow them, and they apply only if you are moving queries off
the Prisma client and onto gemi's ORM. Both are breaks you are not told about —
the code compiles, runs, and passes its tests on either side of the move — so
they are worth reading before the port rather than after. Those two the codemod
*does* now find and annotate; see [Both of these are annotated by `bunx gemi
migrate`](#both-of-these-are-annotated-by-bunx-gemi-migrate).

## Declare your model modules on the Kernel

**Do this even if nothing else in your app changes.** Until you do, a policy on
a model subclass is skipped inside every nested `include`.

A relation read resolves its target through the ORM registry *by name*. The
generated `index.ts` registers each base under its model's name, so unless your
own subclass replaces it there, `User.findMany({ include: { memberships: true } })`
runs the generated `MembershipModel` — which carries none of the policies you
wrote on `Membership`. Scoped at the root, unscoped inside the include, with
nothing to notice it. A model you only ever read *through* an include never
raises, because the query-time guard compares the class being run against the
registered one and they are the same class.

Put your model classes in a barrel and list it:

```ts
// app/models/index.ts
export { User } from "./User"
export { Membership } from "./Membership"
```

```ts
// app/kernel/Kernel.ts
import * as generated from "../models/generated"
import * as models from "../models"

export default class extends Kernel {
  models = [generated, models]
}
```

`boot()` registers every class those modules export under the name its schema
carries — later modules winning, so each subclass takes the name its generated
base was holding — and then refuses to start if any policied class lost its name
to something else. The `register("User", User)` lines become unnecessary; they
still work, and are still what you write for a class in a module the Kernel is
not handed.

In development, a Kernel with an empty `models` and a populated registry now
warns at boot, so an app that skips this hears about it once per start rather
than never.

See [docs/orm.md](./docs/orm.md#your-model-class) for the full rules, including
what happens with a typed view that carries its own policies.

### And then run the check once

`Kernel.models` can only audit the modules it is handed, so the mistake it
removes has a smaller version one level up: a policied class in a file the
barrel does not re-export. Nothing raises for that either.

```sh
bunx gemi check models
```

It walks `app/models`, imports every file, and reports any policied class the
declared modules do not register — with the `export` line that fixes it. Exit
code `1` on a finding, so it is worth a step in CI. It imports what it walks,
which matters if a file under `app/models` does work on import; `--ignore` takes
a comma-separated list, and the command prints what it skipped.

## Regenerate — this one is required

One command, and unlike the rest of this page it is not optional:

```sh
bunx prisma generate
```

**The schema artifact's version moved from 1 to 2**, so a `app/models/generated`
emitted before 0.51 is now refused at registration with `StaleSchemaArtifactError`
telling you to run exactly that. The bump is deliberate. Artifact version 1 also
covered a *newer* artifact being read by an *older* runtime — the two do not
travel together, because the generated directory is committed to git while the
gemi version lives in a lockfile, so a teammate who pulls without installing had
a real chance of pairing them. Version 1 said nothing in that case, and the
mismatch surfaced as a column bound to NULL rather than as an error.

Two things arrive with it, and both need the regenerate to take effect:

- **`@default(nanoid())` and `@default(ulid())` now work.** Both were classified
  as database-side defaults, and neither has a database default to fall back on
   — Prisma fills them in its client. Every `create` on a model using one failed
  on NOT NULL. See [docs/orm.md](./docs/orm.md#column-defaults).
- **`@default(uuid(7))` mints a v7.** The version argument used to be dropped, so
  a column declared v7 got random v4s — still valid UUIDs, no longer sorted by
  creation time, and indistinguishable by eye.

The generator also marks each base it emits with `static $generated = true`, and
`Kernel.models` reads that mark to decide which of several classes claiming one
name is the generated one and which is yours. Artifacts generated before 0.51
carry no mark, so registration falls back to the older signal — whether a class
declares `$schema` itself — which a subclass that redeclares `static $schema`
defeats, handing the name to the base.

### One schema may now fail to generate

`@default(cuid(2))` is refused, naming the field. Prisma builds a cuid2 through
`@paralleldrive/cuid2`, which hashes with SHA-3; gemi cannot reproduce that, and
the two formats do not agree anyway — a cuid2 is 24 characters and letter-first,
a cuid v1 is 25 and always starts `c`. Before this, gemi dropped the argument and
wrote v1s into the column, so the rows it created and the rows Prisma created had
different shapes. Use `@default(cuid(1))`, or keep the Prisma client for that
model.

## `@prisma/client` is gone

0.51 removed the type-only `@prisma/client` import from the generated model
bases, so an app installs `prisma` alone. Delete the `generator client` block
from every `.prisma` file, `bun remove @prisma/client`, and re-run
`bunx prisma generate`.

Your queries do not change. Two things start failing to compile that used to
type-check and throw at runtime — `cursor` and `distinct`, which gemi refuses by
design — and `_sum` / `_avg` are now restricted to numeric columns. If you
passed `Prisma.DbNull`, `Prisma.JsonNull` or `Prisma.AnyNull`, import them from
`gemi/orm` instead.

### What to write instead of `distinct` and `cursor`

The compile error says the key is unknown, which does not tell you the useful
part: both were doing something you probably did not want.

**`distinct` was applied in memory.** Prisma's query log shows no `DISTINCT` at
all — the engine reads the rows and deduplicates them in JavaScript. So a
`take` beside it neither reduced the rows pulled from the database nor
paginated by distinct group, which is a performance and a correctness problem
rather than a stylistic one. Write it as SQL.

On **Postgres**, `distinct on` says it directly:

```ts
const rows = await DB.query(sql`
  select distinct on ("userId") "userId", "createdAt"
  from "Session" order by "userId", "createdAt" desc
`);
```

`distinct on` is Postgres-only — SQLite answers `near "on": syntax error`. The
portable form is a window function, which both dialects have:

```ts
const rows = await DB.query(sql`
  select "userId", "createdAt" from (
    select "userId", "createdAt",
           row_number() over (partition by "userId" order by "createdAt" desc) as "rn"
    from "Session"
  ) where "rn" = 1
`);
```

Reproducing Prisma's behaviour faithfully would have meant hiding a full read
and a JavaScript dedupe behind an argument that reads like a database
operation; emitting a real `DISTINCT ON` under the same name would have
silently diverged from Prisma. Hence neither.

**`cursor` is only correct under a total ordering**, which Prisma does not
enforce — under a non-unique `orderBy` it silently skips or repeats rows at the
page boundary. Use `take` with a `where` on the last row's sort key, or compose
the keyset comparison with `sql`.

If you reach either from untyped code the runtime says the same thing, at
length, rather than failing generically.

The full detail, including the `Prisma.*` type mapping, is under
**Setup** in [docs/orm.md](./docs/orm.md#setup); the reasoning for these two is
under [Not in scope](./docs/orm.md#not-in-scope).

## Check `app/cron` and `app/jobs` before you drop the explicit list

0.51 discovers jobs from the filesystem. Every `Job` subclass under `app/jobs` is
registered and every `CronJob` under `app/cron` is scheduled — unless the config
slice declares `jobs` itself, which still wins and still reads no directory.

**Nothing to do if your `app/config/queue.ts` and `app/config/schedule.ts`
already declare `jobs`.** That includes `jobs: []`, which every app scaffolded
before 0.51 has in `app/config/queue.ts`: an empty array is an application saying
it has no jobs, it is honoured as such, and nothing starts running under you.
Delete the key when you want the directory read instead.

Two things to look at before you do:

- **A job you switched off by unlisting it.** Deleting a class from the array and
  leaving the file in place used to disable it. Discovery finds the file, so it
  starts running on the next boot. Delete the file, or keep the explicit list.
- **Anything in those directories that is not a declaration.** Finding the
  classes means importing the files — a class does not exist until its module has
  run — so a helper sitting in `app/cron` that opens a connection or seeds a
  cache at the top level now does that at boot, on every start. Move it out, or
  keep the explicit list and skip the walk.

The walk itself skips `.d.ts` files, tests and benchmarks by their filename
suffix, dot-directories, `node_modules`, and anything under a directory with its
own `package.json`. Nothing else is guessed at, so a file it cannot import fails
the boot naming itself rather than being quietly left out.

Both directories are covered in [docs/cron.md](./docs/cron.md) and
[docs/jobs-and-queues.md](./docs/jobs-and-queues.md).

## A `code === "P2002"` check stops firing when its write moves onto the ORM

Do this before you move the first write, because afterwards nothing will tell
you:

```sh
rg -n '"P2002"'
```

From the repository root rather than from `app/`: these guards live wherever the
retry does, and a shared `lib/errors.ts` is as likely a home as a controller.

Prisma reports a unique collision as a `PrismaClientKnownRequestError` carrying
`code: "P2002"`. gemi reports it as a `UniqueConstraintError`, which carries
`model`, `operation`, `fields` and `constraint` — and no `code`, anywhere on its
prototype chain. So the moment the write inside the `try` becomes an ORM call,
`error.code === "P2002"` is `false`, the recovery branch stops running, and the
`throw error` line under it — the one you wrote for *some other error* —
rethrows the collision you were handling.

Every guard of this shape sits in code that *expects* the collision: catch it,
re-read, retry. That is the only reason to test for it. So the branch that stops
running is the branch holding a race together.

**It is silent in four independent ways at once, which is why this is a grep
rather than a note.**

- **`tsc` is happy.** The guard takes `unknown` and narrows before reading
  `.code`. That is the correct way to write it, and it stays correct against an
  error that has no `code` — a type error here would need TypeScript to know
  which error your `try` can now produce, which is a runtime fact.
- **The runtime is happy.** Nothing new throws. The `catch` still runs, the
  condition is false, and the rethrow arm does its job perfectly — that arm
  exists to absorb exactly this.
- **The tests are happy.** They reject with `{ code: "P2002" }`, because that is
  what the code under test used to receive. They still pass, over a branch
  production can no longer reach.
- **Production is happy until the race happens.** A unique collision is rare and
  load-dependent by nature. The symptom is not a missing retry; it is whatever
  the rethrown error becomes three frames up, at a moment nobody can reproduce.

In the first real port this reached review inside a merge-ready pull request —
`tsc` clean, ~2700 tests green — carrying two dead guards: one on a credit
balance read, one on an idempotent credit purchase. A human reading the diff
caught them, and nothing else in the pipeline was capable of it.

### The replacement

```ts
import { isUniqueConstraintError } from "gemi/orm";

try {
  return await Invite.create({ data: { token } });
} catch (error) {
  if (!isUniqueConstraintError(error)) throw error;
  return await Invite.findUniqueOrThrow({ where: { token } });
}
```

```ts
function isUniqueConstraintError(error: unknown): error is UniqueConstraintError
```

It tests `instanceof UniqueConstraintError` **or** `error.name ===
"UniqueConstraintError"`, and the second half is why it is worth importing
instead of writing `instanceof` at the call site. `instanceof` compares against
*one module instance's* class object, so it is false across a duplicate copy of
`gemi/orm` — two versions in one dependency tree, a linked build beside a
bundled one, a monorepo package resolving its own. The error is the right error,
thrown by the right code, and your guard silently does not fire. That is not
hypothetical: duck-typing rather than importing the class is precisely what the
ported application had already done for *Prisma's* error, for precisely this
reason.

Other `P` codes have gemi errors too — `P2025` is `RecordNotFoundError`, for
instance — but `P2002` is the one gemi ships a predicate for and the only one the
codemod looks for. If you branch on others, the full table is under
[Errors](./docs/orm.md#errors).

### While some writes are still on Prisma

A port is not atomic, and during one a collision on the same table can arrive as
either error depending on which module wrote the row. Keep both, in one place,
with the temporary arm marked as temporary:

```ts
// app/lib/errors.ts
import { isUniqueConstraintError } from "gemi/orm";

// TODO(port): drop the second arm — and this wrapper with it — when the last
// write leaves the Prisma client.
export const isUniqueCollision = (error: unknown) =>
  isUniqueConstraintError(error) ||
  (typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002");
```

Wrap gemi's predicate rather than re-testing `instanceof` yourself: the name
branch is the half you cannot write correctly by hand, and it is the half that
survives a duplicate module copy.

**gemi deliberately does not ship that second arm.** A Prisma code in gemi's
permanent surface would imply the rest of the taxonomy came with it — `P2003`,
`P2025`, `P2034`, and the fifty others an application would then reasonably
expect to catch — and a compatibility surface that covers `P2002` and not
`P2034` fails in exactly the same silent way, one layer further in. It would
also be a bridge with no end: inside the framework there is nowhere to write the
line saying when to delete it. In your own module there is, and it is the
comment above.

### Fix the tests in the same pass, not after

A mock that rejects with `{ code: "P2002" }` keeps a dead guard green — that is
the third silence above, and it outlives the fix unless you go and get it.
Reject with the real error:

```ts
import { UniqueConstraintError } from "gemi/orm";

vi.mock("@/app/models", () => ({
  Invite: {
    create: vi
      .fn()
      .mockRejectedValue(new UniqueConstraintError("Invite", "create", ["token"])),
    findUniqueOrThrow: vi.fn(),
  },
}));
```

`UniqueConstraintError` is exported from `gemi/orm` for exactly this. The
mocking pattern itself is under **Transactions → Unit-testing code that opens
one** in [docs/orm.md](./docs/orm.md#transactions).

## `take` and `skip` built from a query string must be integers

The rule is not new and is not changing. gemi refuses a `take` or a `skip` that
is not an integer, where Prisma truncated it toward zero:

```
InvalidArgumentError: Invalid 'take' (Post.findMany). Expected an integer, got 1.5.
```

It refuses rather than coercing because there is no coercion both dialects agree
on: binding `limit 1.5` is an opaque `SQLITE_MISMATCH` on SQLite and two rows on
Postgres, which rounds. One rule, failing loudly, beats three behaviours — the
reasoning is under [Querying](./docs/orm.md#querying) and it stands. What is new
is only this: a Prisma application has been getting the truncation for free, and
the code that relied on it keeps compiling.

**It is invisible by construction, in three ways:**

- **`tsc` cannot see it.** `Number(x)` is a `number` and `take` takes a
  `number`. TypeScript has no integer type, so there is no annotation that would
  have caught this and none is coming.
- **The unit tests cannot see it.** Every test passes an integer, because an
  integer is what a developer types. `take: 25` has never been a bug.
- **The failing input is not written by your code.** It is a hand-edited URL, a
  shared link carrying a stale query string, an infinite-scroll client computing
  a page size from the viewport, or a form's cleared field arriving as
  `?perPage=` — and `Number("")` is `0`, so that one computes `skip: -25`, which
  is refused as well.

In the first real port, nine controllers derived pagination straight from the
query string in the same two copied lines. Seven of them broke. The two that
were caught were caught by a human reading the diff.

It takes two greps, because the argument and the value that reaches it are
usually in different files:

```sh
rg -n '\b(take|skip):' app/
rg -n 'Number\(' app/ | rg -i 'page|limit|per.?page|offset|take|skip'
```

### The replacement

```ts
import { paginate } from "gemi/orm";

async list(req: HttpRequest) {
  const { take, skip } = paginate({
    page: req.search.get("page"),
    perPage: req.search.get("perPage"),
  });
  return Post.findMany({ take, skip, orderBy: { createdAt: "desc" } });
}
```

```ts
function paginate(
  args: { page?: unknown; perPage?: unknown },
  options?: { perPage?: number; maxPerPage?: number },
): { take: number; skip: number }
```

The arguments are `unknown` on purpose: a query string is where these values
come from, and typing them `number` would mean every caller writes the
`Number(...)` that is the bug. `req.search.get` hands back `string | string[]`,
a JSON body hands back whatever was sent, and both go in unconverted.

**The guarantee is that its output cannot be refused.** Every return is a pair
of integers with `take >= 1` and `skip >= 0`, for every input — `"2.5"`, `"-1"`,
`""`, `"abc"`, `"1e400"`, an array, `undefined`, a missing key. So a route built
on it has no page argument that can 500.

- `perPage` defaults to **25**, which is the number gemi's own examples used to
  teach as `|| 25` — so moving a call site onto the helper does not change
  anybody's page size.
- A *request* may not ask for more than **100** rows, because `?perPage=100000`
  otherwise reads the table into memory. An endpoint that legitimately serves
  larger pages says so where it is written: `paginate(args, { maxPerPage: 500 })`.
- A `page` below 1 is clamped up rather than refused. The values that land there
  are `""`, `"0"` and `"-1"`, and none of them is a request for a page that does
  not exist; a 500 on a hand-edited link is the wrong answer.

**`Number(x) || 1` is not the fix**, and it is worth knowing how far it does
get: it rescues `?page=` and `?page=0`, because both are falsy. It does not
rescue `?page=-1`, `?page=2.5` or `?page=1e400` — a negative `skip` and a
fractional one are both refused, and `1e400` is `Infinity`, which `Math.trunc`
cannot fix either.

### On the client

`paginate` belongs to the query layer and has no business in a browser bundle.
The value still needs truncating where it is read, because a page number the
client increments arrives at the server *multiplied* — as a fractional `skip`:

```tsx
const asked = Number(searchParams.get("page"));
const page = Number.isFinite(asked) ? Math.max(1, Math.trunc(asked)) : 1;
```

The `Number.isFinite` is not decoration, and it is the half that is easy to drop:
`?page=1e400` is `Infinity`, which `Math.trunc` returns unchanged and `Math.max`
keeps — so a shorter clamp hands the component `Infinity`, writes `?page=Infinity`
back into the URL on the next click, and renders `NaN` on any `page - 1` control.
That is the same test the server-side `toWholeNumber` makes, for the same reason.

## Both of these are annotated by `bunx gemi migrate`

The codemod carries two annotate-only passes over everything under `app/`. They
are re-run-safe, so this is worth doing even on an app already on 0.43:

```sh
bunx gemi migrate --dry-run   # print the plan, write nothing
bunx gemi migrate
rg 'TODO\(gemi-migrate\)'
```

- **The `"P2002"` pass** annotates every `P2002` literal in a file that also
  imports from your model surface (`gemi/orm`, or a path ending in `models`),
  and points at `isUniqueConstraintError` and the two-armed bridge above. Two
  things it cannot find: a guard living in a shared `lib/errors.ts` that imports
  nothing from your models — which is what the plain `rg` above is for — and a
  check spelled `err.code?.startsWith("P200")`, since it matches the exact
  literal only.
- **The `take` / `skip` pass** annotates any `take:` or `skip:` whose value is
  not provably an integer, and points at `paginate`. Integer literals (including
  `1_000`), a whole `Math.trunc(…)` / `Math.floor(…)` / `parseInt(…)` call, and
  `take?: number` in a type declaration are *not* flagged — so a call site you
  have already truncated is silent for a reason rather than by oversight.

The second pass asks you to confirm rather than telling you it found a bug, and
it is worded that way on purpose: whether a value holds an integer is a runtime
fact, most non-literal `take`s are fine, and a marker that is wrong most of the
time is a marker people learn to skim past. Neither pass rewrites anything.

The full description, including what each annotation says, is under [Porting a
Prisma app onto the ORM](./docs/cli.md#porting-a-prisma-app-onto-the-orm).

## `@updatedAt` now needs a column beside it

**This one changes behaviour for apps already on gemi's ORM, not only for apps
porting off Prisma** — it is the only entry here that does, which is why it is
worth reading even if you have no Prisma left.

The stamp used to fire on every `update` call. It now fires on every call that
**sets at least one column**, which is the rule Prisma follows. Measured against
6.19.2 by seeding the column to the epoch and reading it back:

```
data: {}                                epoch    not stamped
data: { profile: { create: … } }        epoch    not stamped     nested write, child holds the key
upsert hit, update: {}                  epoch    not stamped
updateMany({ data: {} })                epoch    { count: 0 }
data: { name: "real" }                  now      stamped
data: { organization: { connect: … } }  now      stamped          writes this row's foreign key
```

Nothing that writes a column changes. What changes is the calls that write
none — and there is one spelling worth searching for before you upgrade:

```ts
await User.update({ where: { id }, data: {} })   // no longer moves updatedAt
```

If you used that as a *touch* — a write with an empty payload, to bump the
timestamp — it is now a read and the stamp stays where it was. It never worked
that way under Prisma, so a ported app cannot depend on it; an app written
against gemi's ORM directly could. Set the column yourself where you meant to:

```ts
await User.update({ where: { id }, data: { updatedAt: new Date() } })
```

The same applies to a `data` of only nested writes whose child holds the foreign
key. Those write the *child* and nothing on the parent, so the parent's stamp no
longer moves — which is what Prisma does, and what the ORM previously did not.

**Why it changed rather than being left alone.** Stamping unconditionally made
the empty-`data` read unreachable on any model carrying the attribute, because
the stamp was itself the assignment keeping the statement from being empty — so
the fix for `data: {}` was the same fix. And it put a timestamp Prisma does not
write on every nested to-one write, where the differential harness could not see
it: `updatedAt` is compared as a volatile descriptor, so two different instants
match. It took asserting the epoch by hand to find.

**One divergence remains, deliberately.** An owning-side `disconnect` writes the
foreign key and so stamps here; Prisma writes the same column through the same
operand family and does *not*, while its `connect` one operand over does. That is
Prisma disagreeing with itself, and matching it would mean special-casing one
operand to reproduce an inconsistency.

An owning-side `upsert` — `data: { organization: { upsert: … } }` — inherits it
on the branch that **updates**. The foreign key is written back unchanged there,
because the create branch needs that column in the statement and which branch
runs is not known until the call runs, so the parent's stamp moves where
Prisma's does not. The far row is updated identically on both. Worth searching
for in the same places as the `disconnect` above: a row whose `updatedAt` you
show, written through a relation rather than through a column.

---

# Upgrading from 0.42 to 0.43

0.43 replaces the 16 hand-written `*ServiceContainer` singletons and the
`*ServiceProvider` config-bag classes with one Laravel-style container. This is
a **hard break**: there are no deprecation aliases and no back-compat shims.
Everything you need to change is listed below, and most of it is automated.

```sh
# from your app's root, with gemi 0.43 installed
bunx gemi migrate --dry-run   # see the plan
bunx gemi migrate             # apply it
```

The codemod prints a per-file summary of everything it could not translate and
leaves a `TODO(gemi-migrate):` comment at each of those spots. Grep for it when
it finishes:

```sh
rg 'TODO\(gemi-migrate\)'
```

---

## 1. Providers became config

In 0.42 you configured the framework by subclassing a provider and overriding
properties. In 0.43 those same values are a plain object exported from
`app/config/<slice>.ts`.

```ts
// 0.42 — app/kernel/providers/EmailServiceProvider.ts
import { EmailServiceProvider, ResendDriver } from "gemi/services";

export default class extends EmailServiceProvider {
  driver = new ResendDriver();
}
```

```ts
// 0.43 — app/config/mail.ts
import { defineMailConfig, ResendDriver } from "gemi/services";

export default defineMailConfig({
  driver: new ResendDriver(),
});
```

Overridden **methods** become callback keys — `async onSignUp(user, token) {}`
in a class body is `async onSignUp(user, token) {},` in the object literal. The
codemod does this conversion mechanically and preserves your comments and
formatting.

| 0.42 provider | 0.43 config file | helper | import from |
| --- | --- | --- | --- |
| `AuthenticationServiceProvider` | `app/config/auth.ts` | `defineAuthConfig` | `gemi/services` |
| `EmailServiceProvider` | `app/config/mail.ts` | `defineMailConfig` | `gemi/services` |
| `LoggingServiceProvider` | `app/config/log.ts` | `defineLogConfig` | `gemi/services` |
| `FileStorageServiceProvider` | `app/config/filesystem.ts` | `defineFilesystemConfig` | `gemi/services` |
| `QueueServiceProvider` | `app/config/queue.ts` | `defineQueueConfig` | `gemi/services` |
| `RedisServiceProvider` | `app/config/redis.ts` | `defineRedisConfig` | `gemi/services` |
| `BroadcastingServiceProvider` | `app/config/broadcast.ts` | `defineBroadcastConfig` | `gemi/services` |
| `ImageOptimizationServiceProvider` | `app/config/image.ts` | `defineImageConfig` | `gemi/services` |
| `RateLimiterServiceProvider` | `app/config/ratelimiter.ts` | `defineRateLimiterConfig` | `gemi/services` |
| `CronServiceProvider` | `app/config/schedule.ts` | `defineScheduleConfig` | `gemi/services` |
| `I18nServiceProvider` | `app/config/translation.ts` | `defineTranslationConfig` | `gemi/i18n` |
| `MiddlewareServiceProvider` | `app/config/middleware.ts` | `defineMiddlewareConfig` | `gemi/http` |
| `ApiRouterServiceProvider` | `app/config/route.ts` (`api`) | `defineRouteConfig` | `gemi/services` |
| `ViewRouterServiceProvider` | `app/config/route.ts` (`view`) | `defineRouteConfig` | `gemi/services` |

The two router providers collapse into a single `route` slice:

```ts
// app/config/route.ts
export default defineRouteConfig({
  api: { rootRouter: RootApiRouter },
  view: { rootRouter: RootViewRouter, root: createRoot(RootLayout) },
});
```

`route` is the only mandatory slice — `route.api.rootRouter`, `route.view.root`
and `route.view.rootRouter` have no defaults. Everything else can be omitted
entirely.

### One property was retired

`AuthenticationServiceProvider.adapter` briefly became `auth.userProvider`, and
then the seam it selected between was removed altogether: auth persistence is
now the ORM-backed `UserProvider`, and `AuthConfig` has no field for it.

The codemod comments the member out and leaves a TODO carrying the replacement —
subclass `UserProvider` from `gemi/kernel`, override the methods the adapter
implemented, and install it by rebinding `AuthManager` (from `gemi/services`) in
a ServiceProvider, which takes the provider as its second constructor argument.
The same TODO is written over a `userProvider` field left in an
`app/config/auth.ts` by an earlier migration. See
[docs/authentication.md](docs/authentication.md) for the worked example.

---

## 2. The Kernel

```ts
// 0.42
export default class extends Kernel {
  authenticationServiceProvider = AuthenticationServiceProvider;
  emailServiceProvider = EmailServiceProvider;
  // ...one field per provider
}
```

```ts
// 0.43
import { Kernel } from "gemi/kernel";
import auth from "../config/auth";
import mail from "../config/mail";
import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  config = { auth, mail };
  providers = [AppServiceProvider];
}
```

`config` is merged into the container's config `Repository` and read lazily.
`providers` runs **after** the 14 framework providers, so an app provider can
rebind anything the framework bound.

Two Kernel bugs disappear with the old shape: the misspelled
`broadcastingsServiceProvider` field (which made broadcast channels
unoverridable) and `imageServiceProvider`, which was never honoured at all. Both
are ordinary config slices now.

---

## 3. Facades

Only two identifiers changed, both from `gemi/facades`:

| 0.42 | 0.43 |
| --- | --- |
| `FileStorage` | `Storage` |
| `I18n` | `Lang` |

Method names and signatures are unchanged, so this is a pure rename — the
codemod handles it everywhere, including inside provider bodies on their way to
`app/config`.

`Auth`, `Log`, `Redis`, `Broadcast`, `Query`, `Cookie`, `Redirect`, `Url` and
`Meta` are untouched. `Facade` is now exported too, if you want to write your
own:

```ts
import { Facade } from "gemi/facades";

export class Billing extends Facade {
  static getFacadeAccessor() {
    return BillingManager;
  }
  static charge(amount: number) {
    return this.getFacadeRoot().charge(amount);
  }
}
```

---

## 4. `*ServiceContainer.use()` is gone

Every `SomethingServiceContainer` is now a plain class resolved from the
container. If you called `.use()` anywhere, replace it:

```ts
// 0.42
import { EmailServiceContainer } from "gemi/services";
const mail = EmailServiceContainer.use().service;

// 0.43
import { app } from "gemi/foundation";
import { MailManager } from "gemi/services";
const mail = app(MailManager);
```

The codemod renames the identifier and drops a `TODO(gemi-migrate):` on the call
site, but **it does not rewrite the call itself** — `.use().service` unwrapping
varied enough across call sites that a blind rewrite would be wrong more often
than right.

| 0.42 | 0.43 | token |
| --- | --- | --- |
| `AuthenticationServiceContainer` | `AuthManager` | `auth` |
| `EmailServiceContainer` | `MailManager` | `mail` |
| `LoggingServiceContainer` | `LogManager` | `log` |
| `FileStorageServiceContainer` | `FilesystemManager` | `filesystem` |
| `QueueServiceContainer` | `QueueManager` | `queue` |
| `RedisServiceContainer` | `RedisManager` | `redis` |
| `BroadcastingServiceContainer` | `BroadcastManager` | `broadcast` |
| `ImageOptimizationServiceContainer` | `ImageManager` | `image` |
| `ApiRouterServiceContainer` | `ApiRouteDispatcher` | `router.api` |
| `ViewRouterServiceContainer` | `ViewRouteDispatcher` | `router.view` |
| `I18nServiceContainer` | `Translator` | `translator` |
| `RateLimiterServiceContainer` | `RateLimiter` | `ratelimiter` |
| `CronServiceContainer` | `Scheduler` | `scheduler` |
| `MiddlewareServiceContainer` | `MiddlewareRegistry` | `middleware` |
| `KernelIdServiceContainer` | `KernelId` | `kernel.id` |

`ApiRouter` and `ViewRouter` — the classes you subclass to declare routes — are
**not** affected. They keep their names and their `gemi/http` export.

---

## 5. `Singleton` was removed

`SingletonServiceContainer` and the `Singleton` base class are gone;
`Container.singleton()` subsumes them.

```ts
// 0.42
import { Singleton } from "gemi/services";
export class Clock extends Singleton {}
const clock = Clock.use();

// 0.43
import { app } from "gemi/foundation";
export class Clock {}

// in a ServiceProvider's register():
this.app.singleton(Clock, () => new Clock());

// anywhere:
const clock = app(Clock);
```

The codemod cannot do this one — the replacement depends on where you want the
binding registered. It flags every `Singleton` import with a
`TODO(gemi-migrate):`.

---

## 6. Writing your own provider

`ServiceProvider` moved from `gemi/services` to `gemi/support` and changed
meaning: it registers *into* a container rather than being a config bag handed
*to* one. `boot()` is no longer abstract-and-ignored — it actually runs.

```ts
import { ServiceProvider } from "gemi/support";

export default class BillingServiceProvider extends ServiceProvider {
  // Phase 1. Bind only. Nothing may be resolved here.
  register() {
    this.app.singleton(
      BillingManager,
      () => new BillingManager(this.app.config.get("billing", {})),
    );
  }

  // Phase 2. Every provider has registered, so resolving is safe.
  async boot() {}
}
```

Register it in the Kernel's `providers` array. The codemod moves the import to
`gemi/support` and, for any provider under `app/kernel/providers/` it does not
recognise, leaves the file on disk and lists it in `providers` with a TODO.

### The boot split matters

`register()` is synchronous and runs during `Kernel.boot()`. `boot()` is async
and runs during `Kernel.waitForBoot()`, which `Server.start()` awaits before
binding the port. If you have async setup, it goes in `boot()`, not
`register()`.

### Services are now built lazily

In 0.42 every `*ServiceContainer` was constructed during `Kernel.boot()`. In
0.43 `singleton()` bindings are built on first `make()`, so a service whose
constructor throws now fails at its first use rather than at startup. Three
providers opt back into eager construction with a `boot()`, because their
readiness is a genuine startup concern:

| Provider | Why it resolves in `boot()` |
| --- | --- |
| `RouteServiceProvider` | Flattens the route tables and runs the reserved-path assertion — a bad route table must fail the boot, not the first request. |
| `LogServiceProvider` | Creates the log directory once, instead of adding file IO to whichever handler logs first. |
| `KernelIdServiceProvider` | Binds a pre-built id with `instance()` so the value is stable from the moment the app exists. |

Everything else is lazy on purpose. The two worth calling out:

- **Redis.** `new RedisClient(url)` does not connect (Bun connects on the first
  command), so nothing is deferred except URL parsing. Keeping it lazy is what
  lets `gemi build` run without a valid `REDIS_URL`.
- **Cron.** `ScheduleServiceProvider.boot()` registers the `Bun.cron` handles.
  0.42 registered them in the container's constructor, which meant `gemi build`
  scheduled jobs it then had to tear down; that no longer happens.

If you want startup validation for one of your own services, resolve it in your
provider's `boot()` — that is the whole mechanism.

---

## 7. New public modules

```ts
import { Kernel, frameworkProviders } from "gemi/kernel";
import { app, Application } from "gemi/foundation";
import { Container, BindingResolutionError, type ServiceToken } from "gemi/container";
import { ServiceProvider, Repository, withDefaults } from "gemi/support";
```

`withDefaults(defaults, config)` is the merge the framework's own providers use:
a shallow spread that treats an explicit `undefined` the same as an omitted key,
so a config slice can't erase a default by naming it. Use it in your own
`register()` if your service has defaults.

`app()` returns the `Application`; `app(Token)` resolves a binding and is typed
from the token class, so `app(MailManager)` is a `MailManager` with no cast.

Note that `gemi/config` is the **build** config (`gemi.config.ts`) and is
unrelated — runtime config lives in `gemi/support`'s `Repository`.

---

## What the codemod will not do for you

These are the cases it reports rather than guesses at.

1. **`Singleton` subclasses.** Section 5. The import is flagged; the class body
   and every `.use()` call are left alone.

2. **`.use()` call sites.** The identifier is renamed so the import resolves,
   but the call is flagged, not rewritten. Change
   `X.use().service` to `app(X)` yourself.

3. **Constructors and `static` members on a provider.** A config object has no
   equivalent. They are commented out inside the generated `app/config/*.ts`
   with a TODO, so nothing is lost — decide whether the logic belongs in a
   `ServiceProvider.register()` or in the config value itself.

4. **Providers that extend something the codemod does not know.** Left on disk
   untouched (apart from the `ServiceProvider` import move) and carried into the
   Kernel's `providers` array with a TODO. Make them extend `ServiceProvider`
   from `gemi/support`.

5. **Extra members on your `Kernel` subclass.** Anything that is not a provider
   slot is commented out in the rewritten `Kernel.ts` with a TODO.

6. **Getters on a provider.** `get headers() { … }` is carried over as an object
   getter, which is valid but rarely what you want in a config file. Review it.

7. **Import order and grouping.** The codemod preserves your original import
   order rather than reflowing it. The result is correct but may not match how
   you would have grouped things by hand.

8. **Classes declared inside a provider file.** These are extracted to their own
   module by base class — `HttpRequest` to `app/http/requests/`, `CronJob` to
   `app/cron/`, `Job` to `app/jobs/`, `BroadcastingChannel` to
   `app/broadcasting/`, `Middleware` to `app/http/middleware/`, `Email` to
   `app/email/`, `Policy` to `app/policies/`. A class extending anything else is
   copied into the generated config file as-is and reported — move it somewhere
   sensible.

9. **Anything outside `app/`.** The codemod only walks `app/`. Scripts, tests
   and tooling elsewhere in your repo need the section 3–5 renames applied by
   hand.

---

## A trap worth knowing about

If you set `verifyEmail: false`, make sure you are not calling
`authConfigDefaults()` with no argument anywhere in your own code. The default
`generateEmailVerificationToken` reads `config.verifyEmail` off the merged
config to decide whether to short-circuit; called with no argument it defaults
to `true` and silently keeps minting verification tokens. The framework's own
`AuthServiceProvider` passes the user config through correctly — this only bites
if you build the config yourself.
