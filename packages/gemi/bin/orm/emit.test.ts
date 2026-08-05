import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DMMF } from "@prisma/generator-helper";
import { describe, expect, test } from "vitest";

import { SCHEMA_ARTIFACT_VERSION } from "../../orm/schema";
import {
  UnsupportedSchemaError,
  buildModelSchemas,
  emitArtifacts,
} from "./emit";

/**
 * Every module an emitted file imports, in source order.
 *
 * The emitted files are the whole of an app's contact with this generator, so
 * "what do they resolve" is the property worth asserting — and it has to be read
 * from the imports rather than from the text, because those files carry comments
 * that *name* `@prisma/client` in the course of explaining that they no longer
 * need it.
 */
function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)].map(
    (match) => match[1],
  );
}

// A hand-built DMMF rather than a real `prisma generate` run: the emitters are
// pure functions of it, so the whole generator is testable with no Prisma CLI,
// no engines and no database.
function field(overrides: Partial<DMMF.Field>): DMMF.Field {
  return {
    kind: "scalar",
    name: "id",
    isRequired: true,
    isList: false,
    isUnique: false,
    isId: false,
    isReadOnly: false,
    type: "Int",
    hasDefaultValue: false,
    ...overrides,
  } as DMMF.Field;
}

function model(overrides: Partial<DMMF.Model>): DMMF.Model {
  return {
    name: "User",
    dbName: null,
    schema: null,
    fields: [],
    uniqueFields: [],
    uniqueIndexes: [],
    primaryKey: null,
    ...overrides,
  } as DMMF.Model;
}

const USER = model({
  name: "User",
  fields: [
    field({
      name: "id",
      isId: true,
      hasDefaultValue: true,
      default: { name: "autoincrement", args: [] },
    }),
    field({ name: "email", type: "String", isUnique: true }),
    field({
      name: "createdAt",
      type: "DateTime",
      hasDefaultValue: true,
      default: { name: "now", args: [] },
    }),
    field({ name: "updatedAt", type: "DateTime", isUpdatedAt: true }),
    field({ name: "deletedAt", type: "DateTime", isRequired: false }),
    field({
      kind: "object",
      name: "posts",
      type: "Post",
      isList: true,
      relationName: "PostToUser",
      relationFromFields: [],
      relationToFields: [],
    }),
  ],
});

const POST = model({
  name: "Post",
  dbName: "posts",
  fields: [
    field({ name: "id", isId: true }),
    field({ name: "title", type: "String", dbName: "post_title" }),
    field({ name: "slug", type: "String" }),
    field({ name: "locale", type: "String" }),
    field({
      name: "authorId",
      type: "Int",
    }),
    field({
      kind: "object",
      name: "author",
      type: "User",
      isRequired: true,
      relationName: "PostToUser",
      relationFromFields: ["authorId"],
      relationToFields: ["id"],
    }),
    field({ kind: "enum", name: "status", type: "PostStatus" }),
  ],
  uniqueFields: [["slug", "locale"]],
});

describe("buildModelSchemas()", () => {
  const [post, user] = buildModelSchemas([USER, POST]);

  // Alphabetical rather than declaration order, so reordering the Prisma schema
  // does not churn the generated diff.
  test("orders models by name", () => {
    expect([post.name, user.name]).toEqual(["Post", "User"]);
  });

  // The template's schema has no `@map` / `@@map` at all, so this is the case
  // that is easiest to get silently wrong.
  test("reads table and column names from the schema, never inferring them", () => {
    expect(post.table).toBe("posts");
    expect(post.fields.title.column).toBe("post_title");
    // No pluralising, no snake_casing, no guessing.
    expect(user.table).toBe("User");
    expect(post.fields.slug.column).toBe("slug");
  });

  test("carries defaults, @updatedAt and nullability", () => {
    expect(user.fields.id.default).toEqual({ kind: "autoincrement" });
    expect(user.fields.createdAt.default).toEqual({ kind: "now" });
    expect(user.fields.updatedAt.isUpdatedAt).toBe(true);
    expect(user.fields.deletedAt.nullable).toBe(true);
    expect(user.fields.email.nullable).toBe(false);
  });

  test("records the primary key", () => {
    expect(user.primaryKey).toEqual(["id"]);
  });

  test("collects single-field and composite uniques", () => {
    expect(user.uniques).toEqual([["email"]]);
    expect(post.uniques).toEqual([["slug", "locale"]]);
  });

  test("keeps relations out of fields and describes both sides", () => {
    expect(user.fields.posts).toBeUndefined();
    expect(user.relations.posts).toMatchObject({
      model: "Post",
      kind: "many",
      relationName: "PostToUser",
      from: [],
      to: [],
    });
    expect(post.relations.author).toMatchObject({
      model: "User",
      kind: "one",
      from: ["authorId"],
      to: ["id"],
    });
  });

  // Enum members travel as strings, so the scalar type stays String and the
  // enum's identity is kept for a later iteration.
  test("maps an enum field to String and records the enum name", () => {
    expect(post.fields.status).toMatchObject({
      type: "String",
      enum: "PostStatus",
    });
  });

  // A Decimal generates cleanly and then returns the driver's raw JS number
  // typed as `Prisma.Decimal` — a wrong answer rather than an error, which is
  // the same class as the Date -> NULL binding this iteration is built around.
  test("refuses a Decimal field, which no dialect can round-trip yet", () => {
    expect(() =>
      buildModelSchemas([
        model({ fields: [field({ name: "price", type: "Decimal" })] }),
      ]),
    ).toThrow(UnsupportedSchemaError);

    expect(() =>
      buildModelSchemas([
        model({ fields: [field({ name: "price", type: "Decimal" })] }),
      ]),
    ).toThrow(/User\.price is a Decimal/);
  });

  // Bytes is the near miss: Bun returns a Uint8Array for a BLOB, which is what
  // Prisma 6 returns too, so it is supported rather than refused.
  test("accepts a Bytes field", () => {
    const [only] = buildModelSchemas([
      model({ fields: [field({ name: "blob", type: "Bytes" })] }),
    ]);
    expect(only.fields.blob.type).toBe("Bytes");
  });

  test("refuses a scalar type it cannot map rather than emitting a guess", () => {
    expect(() =>
      buildModelSchemas([
        model({ fields: [field({ name: "geo", type: "Geometry" })] }),
      ]),
    ).toThrow(UnsupportedSchemaError);
  });

  // #300. This used to assert the opposite — "refuses a scalar list" — and the
  // refusal was correct for as long as no dialect could decode an array. What
  // moved is where the refusal lives, not whether there is one: the artifact is
  // dialect-agnostic, so a column that is legal on Postgres and a validation
  // error on SQLite cannot be adjudicated here. SQLite says no at compile time
  // instead, naming itself; see `SqliteDialect.listFilters`.
  test("describes a scalar list rather than refusing it", () => {
    const [only] = buildModelSchemas([
      model({ fields: [field({ name: "tags", type: "String", isList: true })] }),
    ]);
    expect(only.fields.tags).toMatchObject({ type: "String", isList: true });
  });

  // The flag is absent, not `false`, on everything else — which is what keeps a
  // schema with no list generating the artifact it generated before #300, byte
  // for byte, and is why `SCHEMA_ARTIFACT_VERSION` did not have to move.
  test("omits isList on a scalar field", () => {
    const [only] = buildModelSchemas([
      model({ fields: [field({ name: "email", type: "String" })] }),
    ]);
    expect("isList" in only.fields.email).toBe(false);
  });

  // A list of a scalar no dialect can round-trip is not more supportable for
  // being a list, and the error a reader gets should be the *Decimal* one —
  // with the precision reasoning — rather than a generic list refusal.
  test("refuses a Decimal list as a Decimal", () => {
    expect(() =>
      buildModelSchemas([
        model({
          fields: [field({ name: "prices", type: "Decimal", isList: true })],
        }),
      ]),
    ).toThrow(/User\.prices is a Decimal/);
  });

  // An enum list keeps both facts: the element travels as a string, and the
  // column holds many of them.
  test("describes an enum list", () => {
    const [only] = buildModelSchemas([
      model({
        fields: [
          field({ kind: "enum", name: "roles", type: "Role", isList: true }),
        ],
      }),
    ]);
    expect(only.fields.roles).toMatchObject({
      type: "String",
      enum: "Role",
      isList: true,
    });
  });

  // Prisma's own client omits `Unsupported(...)` columns from its result types,
  // so omitting them is what keeps our result shape identical to Prisma's.
  test("omits an Unsupported column", () => {
    const [only] = buildModelSchemas([
      model({
        fields: [
          field({ name: "id", isId: true }),
          field({ kind: "unsupported", name: "geo", type: "Unsupported" }),
        ],
      }),
    ]);
    expect(Object.keys(only.fields)).toEqual(["id"]);
  });

  test("describes an implicit many-to-many join table", () => {
    const tagged = model({
      name: "Tag",
      fields: [
        field({ name: "id", isId: true }),
        field({
          kind: "object",
          name: "posts",
          type: "Post",
          isList: true,
          relationName: "PostToTag",
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
    });
    const posts = model({
      name: "Post",
      fields: [
        field({ name: "id", isId: true }),
        field({
          kind: "object",
          name: "tags",
          type: "Tag",
          isList: true,
          relationName: "PostToTag",
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
    });

    const [post, tag] = buildModelSchemas([tagged, posts]);
    expect(post.relations.tags.joinTable).toEqual({
      table: "_PostToTag",
      a: "Post",
      b: "Tag",
    });
    // Both sides describe the same table, with the same column assignment.
    expect(tag.relations.posts.joinTable).toEqual(post.relations.tags.joinTable);
  });

  /**
   * A *self*-referential implicit m-n, where both ends are the same model and
   * `a === b`. The model names cannot say which column is which, so the record
   * carries the answer per field.
   *
   * **Prisma assigns the columns by field name, alphabetically** — the
   * alphabetically-first of the relation's two fields has its owner in `A`.
   * Established by experiment against a generated client, connecting through
   * each field in turn and reading the join table, because the other plausible
   * rule (declaration order) agrees on every schema whose fields happen to be
   * declared alphabetically and disagrees on the rest. The fields below are
   * declared `zeta` then `alpha` on purpose, so the two rules give opposite
   * answers and this test can only pass under the right one.
   */
  test("a self-referential m-n names the column per field", () => {
    const thing = model({
      name: "Thing",
      fields: [
        field({ name: "id", isId: true }),
        field({
          kind: "object",
          name: "zeta",
          type: "Thing",
          isList: true,
          relationName: "Link",
          relationFromFields: [],
          relationToFields: [],
        }),
        field({
          kind: "object",
          name: "alpha",
          type: "Thing",
          isList: true,
          relationName: "Link",
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
    });

    const [schema] = buildModelSchemas([thing]);

    expect(schema.relations.alpha.joinTable).toEqual({
      table: "_Link",
      a: "Thing",
      b: "Thing",
      ownerColumn: "A",
    });
    expect(schema.relations.zeta.joinTable?.ownerColumn).toBe("B");
  });

  /** A non-self m-n has no ambiguity, so it carries no extra key. */
  test("a two-model m-n names no owner column", () => {
    const tagged = model({
      name: "Tag",
      fields: [
        field({ name: "id", isId: true }),
        field({
          kind: "object",
          name: "posts",
          type: "Post",
          isList: true,
          relationName: "PostToTag",
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
    });
    const posts = model({
      name: "Post",
      fields: [
        field({ name: "id", isId: true }),
        field({
          kind: "object",
          name: "tags",
          type: "Tag",
          isList: true,
          relationName: "PostToTag",
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
    });

    const [post] = buildModelSchemas([tagged, posts]);
    expect(post.relations.tags.joinTable).not.toHaveProperty("ownerColumn");
  });

  // A one-to-many is not a many-to-many, and mistaking one for the other would
  // send iteration 3 looking for a table that does not exist.
  test("does not invent a join table for a one-to-many", () => {
    const [, user] = buildModelSchemas([USER, POST]);
    expect(user.relations.posts.joinTable).toBeUndefined();
  });

  /**
   * **A relation that joins on more than one field**, which every other case
   * here declares with exactly one.
   *
   * **Correcting the reason this was added (#178, #179).** It was justified on
   * two claims that are both false: that the starter template declares no
   * composite relation, and that the artifact's zero-diff test would not catch
   * a truncating generator. The template declares
   * `LedgerEntry.ledger @relation(fields: [tenantId, ledgerCode], …)`, and
   * truncating `emit.ts` to the first field **does** fail that test — the
   * committed artifact holds the right value, so regenerating diverges from it.
   *
   * The measurement behind "only this test notices" was `vitest run orm
   * database`, which is the package suite and excludes the template. Reported
   * as though it were general, it was not.
   *
   * What is still true, and is reason enough on its own: the compiler's
   * composite tests build their own `ModelSchema` fixtures and never run the
   * generator, so this is the only *direct* check of it. It also fails
   * differently — naming the field that went missing, rather than reporting
   * that `prisma generate` produced a diff, which is a slower thing to read and
   * one that a stale committed artifact could mask.
   *
   * Both sides are asserted: `from` and `to` are positional pairs, and a
   * truncation or a reorder on either side is the same bug.
   */
  test("carries every field of a composite relation, on both sides", () => {
    const LEDGER = model({
      name: "Ledger",
      fields: [
        field({ name: "tenantId" }),
        field({ name: "code", type: "String" }),
        field({
          kind: "object",
          name: "entries",
          type: "Entry",
          isList: true,
          relationName: "EntryToLedger",
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
      primaryKey: { name: null, fields: ["tenantId", "code"] } as never,
    });

    const ENTRY = model({
      name: "Entry",
      fields: [
        field({ name: "id", isId: true }),
        field({ name: "tenantId" }),
        field({ name: "ledgerCode", type: "String" }),
        field({
          kind: "object",
          name: "ledger",
          type: "Ledger",
          isRequired: true,
          relationName: "EntryToLedger",
          relationFromFields: ["tenantId", "ledgerCode"],
          relationToFields: ["tenantId", "code"],
        }),
      ],
    });

    const [entry, ledger] = buildModelSchemas([ENTRY, LEDGER]);

    // The owning side names both of its own columns and both of the target's,
    // in declaration order — the pairing is positional.
    expect(entry.relations.ledger.from).toEqual(["tenantId", "ledgerCode"]);
    expect(entry.relations.ledger.to).toEqual(["tenantId", "code"]);

    // The far side names neither, and is resolved through this one at plan
    // time — which is why a truncation here would not show up as a missing key.
    expect(ledger.relations.entries.from).toEqual([]);
    expect(ledger.relations.entries.to).toEqual([]);

    // ...and the composite primary key it references survives too.
    expect(ledger.primaryKey).toEqual(["tenantId", "code"]);
  });
});

/**
 * **Neither the generator nor what it emits reaches `@prisma/client`.**
 *
 * This is the invariant that lets an app install `prisma` alone, and it has two
 * halves that used to have different answers.
 *
 * The generator half was always true: it talks to Prisma over
 * `@prisma/generator-helper`, the JSON-RPC protocol, and reads the DMMF it is
 * handed. It never loaded a client.
 *
 * The *emitted* half was not. `models.ts` carried
 * `import type { Prisma } from "@prisma/client"` and built every signature out
 * of `Prisma.<M>FindManyArgs` and `Prisma.<M>GetPayload<T>`. A type-only import
 * is erased at build and never appears in a bundle — but it still has to
 * *resolve* when the app typechecks, so it put a 74MB package into the
 * dependency graph of every gemi app, and 23MB of generated client into its
 * working tree, for types.
 *
 * It also described the wrong library. `Prisma.<M>FindManyArgs` admits `cursor`
 * and `distinct`; gemi refuses both permanently and by design, so the emitted
 * types type-checked code that threw. The types now come from `gemi/orm`, where
 * the argument grammar matches `READ_ARGS` in the compiler.
 *
 * Asserted on the emitted text rather than trusted, because the failure is
 * silent from the app's side: an emitted import would simply resolve, in a
 * repository that has `@prisma/client` installed for its differential harness,
 * and nothing would fail until someone scaffolded a new app.
 */
describe("the generator's own dependencies", () => {
  const sources = ["bin/orm/emit.ts", "bin/orm-generator.ts"];

  test.each(sources)("%s does not import @prisma/client", (relative) => {
    const source = readFileSync(join(import.meta.dirname, "../..", relative), "utf8");

    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1],
    );

    // `@prisma/generator-helper` is the protocol and is expected; the client is
    // the thing that must not be needed.
    expect(imports).not.toContain("@prisma/client");
    expect(imports.some((name) => name.startsWith("@prisma/"))).toBe(true);
  });

  test("the emitted models file imports no Prisma module at all", () => {
    const models = emitArtifacts([USER, POST])["models.ts"];

    expect(importsOf(models)).toEqual(["gemi/orm", "./schema"]);

    // Not merely "no *value* import": a type import resolves too, and resolving
    // is the whole of the cost this removes. So no Prisma type is named either.
    expect(models).not.toContain("Prisma.");
  });
});

describe("emitArtifacts()", () => {
  const files = emitArtifacts([USER, POST]);

  // Running the generator twice over an unchanged schema must produce a
  // zero-line diff, or every `prisma migrate dev` shows up as noise in review.
  test("is deterministic", () => {
    expect(emitArtifacts([USER, POST])).toEqual(files);
  });

  // Same schema, models declared in the other order.
  test("is insensitive to declaration order", () => {
    expect(emitArtifacts([POST, USER])).toEqual(files);
  });

  test("writes the three artifacts", () => {
    expect(Object.keys(files)).toEqual(["schema.ts", "models.ts", "index.ts"]);
  });

  test("stamps the artifact version so the runtime can refuse a stale one", () => {
    expect(files["schema.ts"]).toContain(
      `export const ARTIFACT_VERSION = ${SCHEMA_ARTIFACT_VERSION};`,
    );
    expect(files["index.ts"]).toContain(
      "assertSchemaArtifactVersion(ARTIFACT_VERSION)",
    );
  });

  test("ends every file with a single trailing newline", () => {
    for (const content of Object.values(files)) {
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    }
  });

  test("emits one concrete base class per model, typed from its descriptor", () => {
    expect(files["models.ts"]).toContain("export class UserModel extends Model");
    expect(files["models.ts"]).toContain(
      "static findMany<T extends FindManyArgs<UserTypes>>",
    );
    expect(files["models.ts"]).toContain("Promise<Payload<UserTypes, T>[]>");
  });

  /**
   * The descriptor is the *facts* about a model — concrete column types,
   * relation targets, unique selectors — and `gemi/orm` supplies the rules over
   * them. Asserted because the split is what keeps the emitted file free of
   * Prisma: a generator that emitted the rules too would have had to name
   * Prisma's mapped types to get `select` narrowing.
   */
  test("emits a type descriptor per model", () => {
    const models = files["models.ts"];

    expect(models).toContain("export interface UserTypes extends ModelTypeInfo");
    expect(models).toContain("export type UserScalars = {");
    expect(models).toContain("export type UserCreateScalars = {");
    expect(models).toContain("export type UserRelations = {");
    expect(models).toContain("export type UserUnique =");
  });

  /**
   * **A model with no relations gets `Record<never, never>`, not
   * `Record<string, never>`.**
   *
   * The two read alike and are opposites. `Record<string, never>` is an index
   * signature valued `never`, so `keyof` it is `string` — and `WhereInput`
   * spreads `{ [K in keyof Relations<M>]?: RelationFilter<…> }`, which then gave
   * the model an index signature that every *scalar* key had to satisfy too. The
   * template's `Membership` could not be filtered, `findUnique`d, updated or
   * deleted, by its own primary key included, while `select` and `orderBy`
   * happened to keep working — so it looked partly broken rather than broken.
   *
   * Nothing reached this branch before: `USER` and `POST` both have relations,
   * and the descriptor test above asserts only that `UserRelations` exists.
   */
  test("a relation-less model gets a keyless relations type", () => {
    const alone: DMMF.Model = {
      name: "Alone",
      dbName: null,
      schema: null,
      fields: [
        field({ name: "id", type: "Int", isId: true, isRequired: true }),
        field({ name: "label", type: "String", isRequired: true }),
      ],
      primaryKey: null,
      uniqueFields: [],
      uniqueIndexes: [],
    };

    const models = emitArtifacts([alone])["models.ts"];

    expect(models).toContain("export type AloneRelations = Record<never, never>;");
    expect(models).not.toContain("Record<string, never>");
  });

  /**
   * A foreign key is optional on `create`, because the relation can supply it.
   *
   * `CreateInput` intersects the scalar half with the relation half, so a
   * required FK made Prisma's canonical `user: { connect: … }` uncompilable —
   * `connect` was offered and simultaneously not sufficient. `compile/write.ts`
   * still raises `MissingRequiredValueError` when neither spelling arrives.
   */
  test("a relation-backed column is optional on create", () => {
    const models = files["models.ts"];
    const create = models.slice(
      models.indexOf("export type PostCreateScalars = {"),
    );

    // `Post.authorId` is required and not defaulted, and backs `Post.author`.
    expect(create).toMatch(/^\s*authorId\?: number;$/m);
    // A column no relation backs keeps its requirement.
    expect(create).toMatch(/^\s*title: string;$/m);
  });

  /**
   * An empty schema emits a header and nothing else — no import block naming
   * twenty-eight types it has no models to use, which the *app's* linter would
   * report in a file it is told not to edit.
   */
  test("a schema with no models emits no imports", () => {
    const models = emitArtifacts([])["models.ts"];

    expect(models).not.toContain("from \"gemi/orm\"");
    expect(models).toContain("Generated by the gemi ORM generator");
  });

  /**
   * A value-level `@map` types as the **database** spelling.
   *
   * Deliberately unlike Prisma, whose client translates the two and whose types
   * therefore say `free`. gemi does not translate — the decoder returns what the
   * column held — so `FREE` is what an application sees and writes. No schema in
   * this repository has one, so the differential harness never compares it, and
   * this is the only thing pinning the decision.
   */
  test("an enum member's @map name is the type", () => {
    const model: DMMF.Model = {
      name: "Tenant",
      dbName: null,
      schema: null,
      fields: [
        field({ name: "id", type: "Int", isId: true, isRequired: true }),
        field({ name: "plan", kind: "enum", type: "Plan", isRequired: true }),
      ],
      primaryKey: null,
      uniqueFields: [],
      uniqueIndexes: [],
    };

    const models = emitArtifacts([model], [
      {
        name: "Plan",
        values: [
          { name: "free", dbName: "FREE" },
          { name: "pro", dbName: null },
        ],
        dbName: null,
      },
    ])["models.ts"];

    expect(models).toContain('plan: "FREE" | "pro";');
  });

  // None of the three generated files imports Prisma, which is the property
  // that lets an app's manifest carry `prisma` and not `@prisma/client`.
  //
  // Asserted on module specifiers rather than on the file's text, for the same
  // reason `runtime-isolation.test.ts` gives: the emitted header *explains* that
  // nothing here resolves to `@prisma/client`, and a text grep cannot tell that
  // sentence from an import.
  test("no generated file imports a Prisma package", () => {
    for (const name of ["models.ts", "schema.ts", "index.ts"] as const) {
      expect(
        importsOf(files[name]).filter((from) => from.startsWith("@prisma/")),
        `${name} imports a Prisma package`,
      ).toEqual([]);
    }
  });

  test("registers every model by name", () => {
    expect(files["index.ts"]).toContain('register("User", UserModel);');
    expect(files["index.ts"]).toContain('register("Post", PostModel);');
  });

  /**
   * **The generator says which classes it wrote, rather than leaving it to be
   * inferred (#318).**
   *
   * `registerModels` has to prefer an application's subclass over the base it
   * extends when both are in one namespace, because electing the base is #316's
   * leak. It used to decide that by asking whether a class declared `$schema`
   * itself — true of the emitted base, false of a subclass — which is an
   * inference about how this file happens to be written, and one a subclass
   * redeclaring `static $schema` defeated.
   *
   * So this line is a contract between two files, and it is asserted at both
   * ends: `isGeneratedBase` reads it, `registration.test.ts` in the template
   * checks that real generator output still carries it.
   *
   * One class per model carries it, because the mark has to be *own* rather than
   * inherited to say anything — a subclass inherits `true` and must still read
   * as an application class.
   */
  test("marks each emitted base as generated", () => {
    const models = files["models.ts"];

    expect(models).toContain("static readonly $generated = true;");
    expect(
      [...models.matchAll(/^\s*static readonly \$generated = true;$/gm)],
    ).toHaveLength(2);
  });

  /**
   * **`readonly`, and the artifact does not typecheck without it.**
   *
   * `Model` declares `declare static $generated?: true`, deliberately the
   * literal rather than `boolean` so that a hand-written `= false` is the type
   * error `isGeneratedBase` reads it as. A mutable `static $generated = true`
   * widens to `boolean`, which is not assignable to `true`, so every class in
   * the emitted file becomes
   *
   *     TS2417: Class static side 'typeof AccountModel' incorrectly extends
   *     base class static side 'typeof Model'.
   *
   * It shipped that way in #319 and was found by an app regenerating a 79-model
   * schema — 79 errors, and 15 in this repository's own template, with every
   * check in CI green. `tsconfig.generated.json` is the gate that now compiles
   * the artifact against the runtime it is generated for; this is the assertion
   * that says *why* the keyword is there, next to the line, so it is not
   * tidied away as noise.
   */
  test("the mark does not widen, because the base declares the literal", () => {
    expect(files["models.ts"]).not.toMatch(/^\s*static \$generated = true;$/m);
  });

  // Generated files hold data and thin delegating methods only. Anything smart
  // in there cannot be hotfixed without a codegen release.
  test("keeps the operations one-line delegations to the choke point", () => {
    expect(files["models.ts"]).toContain(
      'this.$exec("findMany", args, options)',
    );
  });

  /**
   * `options` is a second parameter, not a key inside `args`.
   *
   * That is what keeps `FindManyArgs<UserTypes>` describing exactly what the
   * *query* accepts — one shape, matching `READ_ARGS` in the compiler, with
   * nothing in it the compiler would reject. Intersecting every args type with a
   * gemi-specific key would put a key in the grammar that never reaches SQL. It
   * also keeps the flag away from the plan key, which it must not reach since it
   * does not change the SQL.
   */
  test("per-call options are a second parameter, leaving the arg types intact", () => {
    const models = files["models.ts"];

    expect(models).toContain("options?: ExecOptions,");
    expect(models).toContain("type ExecOptions,");
    expect(models).toMatch(/^} from "gemi\/orm";$/m);

    // The args type is the descriptor's, unintersected.
    expect(models).toMatch(
      /static findMany<T extends FindManyArgs<UserTypes>>\(/,
    );
    expect(models).not.toContain("FindManyArgs<UserTypes> & {");
  });
});
