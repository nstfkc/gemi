# Iteration 1 — Skateboard: generate, and read one row

**Goal.** `User.findMany({ where: { email: "a@b.c" } })` returns correctly typed
POJOs from the template's SQLite database, through the full pipeline, with no
Prisma client at runtime.

This is deliberately the narrowest end-to-end slice. It is worth almost nothing
as a feature and almost everything as a skeleton: every later iteration is filling
in stages that this one puts in place. Resist widening it.

Read [README.md](./README.md) first — especially the six invariants. They are all
established here.

## Read first

- `packages/gemi/database/DatabaseManager.ts` — wraps Bun's `SQL`; exposes `sql`,
  `dialect`, `url`. Bound as a lazy singleton, token `"database"`.
- `packages/gemi/database/dialect.ts` — the `Dialect` union and inference.
- `packages/gemi/container/Container.ts` — bindings key off `static token`, not
  the class object. Resolve with `app(DatabaseManager)` from
  `packages/gemi/foundation/app.ts`.
- `packages/gemi/bin/ide/generateApiManifest.ts` — the house style for a generator.
- `packages/gemi/package.json` — the `bin` map and the `build:bin` script, both of
  which need a second entry; and `scripts/prepare-bin.ts`, which handles shebangs.
- `templates/saas-starter/prisma/schema.prisma` — 8 models, SQLite, no `@map` /
  `@@map`, so table and column names are model and field names verbatim.
- `packages/gemi/database/dialect.test.ts` — test conventions (vitest, colocated).

## Deliverables

### 1. `packages/gemi/orm/schema.ts` — runtime metadata types

Plain data describing a model. Emit **more than this iteration reads** (invariant:
changing the emitted shape later is expensive, regenerating is free):

```ts
// sketch
export interface ModelSchema {
  name: string;              // "User" — registry key
  table: string;             // @@map ?? name
  fields: Record<string, FieldSchema>;
  primaryKey: string[];
  uniques: string[][];       // incl. composite @@unique
  relations: Record<string, RelationSchema>;
}

export interface FieldSchema {
  name: string;              // "organizationId"
  column: string;            // @map ?? name
  type: ScalarType;          // "Int" | "String" | "DateTime" | "Boolean" | "Float" | "BigInt" | "Decimal" | "Json" | "Bytes"
  nullable: boolean;
  isId: boolean;
  isUpdatedAt: boolean;
  default?: DefaultSpec;     // { kind: "autoincrement" | "cuid" | "uuid" | "now" | "value", value?: unknown }
}

export interface RelationSchema {
  name: string;              // "accounts"
  model: string;             // "Account" — resolved lazily via the registry
  kind: "one" | "many";
  from: string[];            // local fields
  to: string[];              // fields on the related model
  joinTable?: { table: string; a: string; b: string };  // implicit m-n; emitted, unused until it3
}

export const SCHEMA_ARTIFACT_VERSION = 1;
```

Nothing here is read from the database at runtime — it is all generated.

### 2. `packages/gemi/orm/dialect/` — dialect strategy

An interface plus a SQLite implementation. Only what iteration 1 needs, but
behind the interface from the start, because SQLite and Postgres diverge on
enough (booleans, dates, `RETURNING`, case-insensitive `contains`) that inline
branching multiplies fast.

```ts
// sketch
export interface SqlDialect {
  readonly name: Dialect;
  quoteIdent(name: string): string;      // sqlite: "User"
  placeholder(index: number): string;    // sqlite: "?"   postgres: "$1"
  decode(value: unknown, field: FieldSchema): unknown;
}
```

`decode` matters immediately: SQLite has no `DateTime` and no `Boolean`. Prisma
stores `DateTime` as integer milliseconds and `Boolean` as `0` / `1`. Returning
raw driver values would already diverge from Prisma's result shape on the
template's `createdAt`.

### 3. `packages/gemi/orm/plan.ts` — the compile/bind split

```ts
// sketch
export interface QueryPlan {
  text: string;
  bind(args: any): unknown[];
  shape(rows: unknown[]): unknown;
}
```

Plus a plan cache: `planKey(model, op, args)` produces a structural hash of the
args **shape** — key paths and operators, never values. Canonicalise before
hashing (sort keys) so `{ where: { a, b } }` and `{ where: { b, a } }` are one
entry, not two.

Cache is a module-level `Map` keyed by `` `${dialect}:${model}:${op}:${shapeHash}` ``.
Unbounded is fine for now; query shapes are finite per application.

### 4. `packages/gemi/orm/compile/` — arg tree → SQL

Only `findMany`, and only scalar equality in `where` (`{ email: "x" }`,
`{ id: 1 }`, multiple keys `AND`ed). A `Fragment` primitive that carries
`{ text, params }` and composes, so iteration 2 extends rather than rewrites.

Non-negotiable while writing this:

- Every value becomes a parameter. Nothing is interpolated — not `take`, not `0`.
- Every identifier is looked up in `ModelSchema` and quoted through the dialect.
  A `where` key with no matching field is an error, not a passthrough.
- Never `SELECT *`. Emit an explicit column list built from the schema, aliased
  to nothing (positional shaping comes in iteration 7).

Expected output for the acceptance query, exactly:

```sql
select "id", "publicId", "name", "email", ... from "User" where "email" = ?
```

### 5. `packages/gemi/orm/shape.ts` — result shaping

Build a shaper once per plan: a fixed list of `(column → output key, decoder)`
closed over, then a tight loop over rows. No per-row `for...in`, no per-row
schema lookups.

For this iteration it maps driver row objects to POJOs and applies
`dialect.decode`. That is all.

### 6. `packages/gemi/orm/registry.ts` — lazy model registry

`register(name, class)` / `get(name)`. Resolution happens at call time. Nothing
in iteration 1 needs to follow a relation, but the registry exists now so that
generated `index.ts` has a stable place to register into and iteration 3 does not
have to touch generated-file layout.

### 7. `packages/gemi/orm/Model.ts` — the choke point

```ts
// sketch
export abstract class Model {
  static $schema: ModelSchema;

  static async $exec(op: Operation, args: any = {}) {
    const db = app(DatabaseManager);
    const dialect = dialectFor(db.dialect);
    const plan = getOrCompile(this.$schema, op, args, dialect);
    const rows = await db.sql.unsafe(plan.text, plan.bind(args));
    return this.$shape(plan, rows);
  }

  static $shape(plan: QueryPlan, rows: unknown[]) {
    return plan.shape(rows);
  }
}
```

`$shape` is a static so a subclass can override it (invariant 3). `$exec` resolves
the connection **per call** through the container — never captured at module
scope, which is what keeps it swappable in tests and what iteration 5 hooks to
pick up an ambient transaction.

### 8. `packages/gemi/orm/errors.ts`

`UnsupportedQueryError` at minimum, naming the offending argument key:

> `gemi ORM does not support 'orderBy' yet (User.findMany).`

Signatures accept the full Prisma arg type from day one; capability grows
underneath them. Any argument key the compiler does not handle **must throw** —
silently ignoring a `take` is the worst possible failure mode.

### 9. `packages/gemi/bin/orm-generator.ts` — a Prisma generator plugin

**Not a `gemi` subcommand.** gemi must not shadow or wrap the Prisma CLI.
Generation is a generator block in `schema.prisma`, so `prisma generate` produces
both artifacts and `prisma migrate dev` refreshes them with no extra step:

```prisma
generator gemi {
  provider = "gemi-orm-generator"
  output   = "../app/models/generated"
}
```

A stdio process built on `@prisma/generator-helper` (add as a **devDependency**
of `packages/gemi`, version-matched to the template's `prisma` ^6.5.0):

```ts
// sketch
generatorHandler({
  onManifest: () => ({
    version,
    prettyName: "gemi ORM",
    defaultOutput: "../app/models/generated",
  }),
  onGenerate: async (options) => {
    // options.dmmf              — full datamodel, no schema parsing needed
    // options.generator.output  — resolved output path
    // options.datasources[0]    — provider; informational only, see below
  },
});
```

Prisma hands over the DMMF directly, so nothing parses `schema.prisma`.

`options.datasources[0].provider` tells the generator which database the schema
targets. **Do not bake it into the output.** `DATABASE_URL` can point somewhere
else at runtime; the dialect stays resolved per call from `DatabaseManager`.
It is useful only for a warning when the datasource looks incompatible.

Writes three files into the configured `output`:

- `schema.ts` — one `ModelSchema` literal per model, plus `SCHEMA_ARTIFACT_VERSION`.
- `models.ts` — one concrete base class per model. This iteration emits only
  `findMany`; later iterations add the other eleven. Type-only
  `import type { Prisma } from "@prisma/client"`, plus the `Subset<T, U>` helper
  copied from Prisma's generated output.
- `index.ts` — registers every base class in the registry and re-exports.

Determinism matters: stable key ordering, stable model ordering, trailing
newline. Running the generator twice must produce a zero-line diff, and there is
an acceptance test for exactly that.

Generated output is **committed**.

### 10. Wire up the template

- `prisma/schema.prisma` — add the `generator gemi { ... }` block.
- `app/models/generated/**` — generated, committed.
- `app/models/User.ts` — `export class User extends UserModel {}`.
- `templates/saas-starter/tsconfig.json` — fold in whatever the generated
  directory needs.

The design-sketch scratch files (`app/db/Models.ts`, `model.ts`,
`app/models/User.ts`) were never committed and have since been removed from the
working tree, so there is nothing to delete. They are worth reading in the
conversation history for the original intent, but not worth resurrecting.

### 11. `packages/gemi/package.json`

- Add `"./orm": "./orm/index.ts"` to `exports`.
- Add a second `bin` entry so Prisma can resolve the provider by name from
  `node_modules/.bin`:
  ```json
  "bin": {
    "gemi": "./dist/bin/gemi.js",
    "gemi-orm-generator": "./dist/bin/orm-generator.js"
  }
  ```
- Add `orm-generator.ts` to the `build:bin` script, and check
  `scripts/prepare-bin.ts` — the generator needs an executable bit and a working
  shebang or Prisma cannot spawn it.
- Add `@prisma/generator-helper` to `devDependencies`.
- The ORM runtime must import nothing from `@prisma/*`. Worth a grep in review.
  The generator is build-time only and may import it freely.

## Acceptance criteria

1. `bunx prisma generate` in `templates/saas-starter` writes the three files
   alongside the Prisma client; running it a second time produces no diff.
   Covered by a test, not by eyeball. No `gemi` subcommand exists for this.
2. A vitest against `templates/saas-starter/prisma/dev.db`:
   `User.findMany({ where: { email: <a seeded address> } })` returns the row, with
   `createdAt` as a `Date` and `deletedAt` as `null` — i.e. decoded, not raw
   SQLite integers.
3. A compiler unit test with no database asserting the **exact** SQL string and
   the **exact** parameter array for that query.
4. A test proving the plan cache works: two calls with the same shape and
   different values compile once (counter or spy) and produce the same `text`
   with different parameter arrays.
5. A test proving `User.findMany({ orderBy: { id: "asc" } })` throws
   `UnsupportedQueryError` naming `orderBy` — not silently ignoring it.
6. `bun run lint` and `bun run test` pass in `packages/gemi`.
7. Grep confirms zero `@prisma/*` imports under `packages/gemi/orm/`, and only
   `import type` occurrences in generated app code.

## Out of scope

Everything else, explicitly: all other `where` operators, `orderBy`, `skip` /
`take`, `select`, `include`, every operation other than `findMany`, Postgres,
writes, transactions, policies, provenance, benchmarks. They have their own
iterations and each has a reason to come later.

## Notes and risks

- **`sql.unsafe` is the right API here**, despite the name. Bun's tagged template
  cannot express a dynamic query. Safety comes from invariant 2 — identifiers
  from the schema, values always parameters — not from the template syntax.
  Worth a comment at the call site so nobody "fixes" it later.
- **Confirm the parameter placeholder style Bun's `unsafe` expects for SQLite**
  before writing the dialect — `?` positional is expected, but verify rather than
  assume, since Postgres will be `$1` and the abstraction depends on getting this
  right the first time.
- **Generator ordering.** Both generator blocks run in one `prisma generate`
  invocation, and the generated `models.ts` type-imports `@prisma/client`. Prisma
  runs generators in declaration order, so `generator client` must come first —
  but do not rely on the ordering silently. If the Prisma client is missing,
  fail with a message that says so rather than emitting code that will not
  typecheck.
- **Verify how Prisma resolves `provider` before building around it.** The
  reliable form is a bin name resolved from `node_modules/.bin`; a relative path
  to an executable also works. Whether a provider string carrying arguments
  (`"bun run ./x.ts"`) is supported has varied across versions — confirm against
  the installed Prisma ^6.5 rather than assuming.
- **The generator is spawned as a separate process by the Prisma CLI**, so its
  shebang and executable bit have to be right, and it must start under whatever
  runtime Prisma spawns it with. `build:bin` currently targets bun; check that
  the emitted `orm-generator.js` actually runs standalone before wiring the
  template to it. This is the most likely thing to cost an unexpected afternoon.
