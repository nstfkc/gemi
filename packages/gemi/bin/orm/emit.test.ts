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
  // The generator refuses it for the same reason it refuses a scalar list.
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

  // Skipping it would silently change the result shape versus Prisma.
  test("refuses a scalar list", () => {
    expect(() =>
      buildModelSchemas([
        model({ fields: [field({ name: "tags", type: "String", isList: true })] }),
      ]),
    ).toThrow(/scalar list/);
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
 * **The generator never imports `@prisma/client`**, which is what makes the
 * generator block's position in `schema.prisma` a matter of convention.
 *
 * `docs/orm.md` used to say the gemi block had to come *after* the `client`
 * one, because "the emitted bases type-import `@prisma/client`, and Prisma runs
 * generators in declaration order". The premise is true and the conclusion does
 * not follow: the emitted import is a **type** import, erased at build, and it
 * only has to resolve when someone typechecks — by which point a single
 * `prisma generate` has produced both outputs whatever order it ran them in.
 *
 * Measured before rewording: swapping the two blocks produces byte-identical
 * `schema.ts`, `models.ts` and `index.ts`.
 *
 * This is the fact the corrected sentence rests on, so it is asserted rather
 * than trusted. If the generator ever does need the client at generation time,
 * the ordering advice comes back — and this fails first.
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

  /** ...while the *emitted* base does import it, as a type. */
  test("the emitted models file imports Prisma as a type only", () => {
    const models = emitArtifacts([USER, POST])["models.ts"];

    expect(models).toContain('import type { Prisma } from "@prisma/client"');
    // ...and never as a value import, which would make it a runtime dependency.
    expect(models).not.toMatch(/^import \{[^}]*\} from "@prisma\/client"/m);
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

  test("emits one concrete base class per model, typed from Prisma", () => {
    expect(files["models.ts"]).toContain("export class UserModel extends Model");
    expect(files["models.ts"]).toContain(
      "static findMany<T extends Prisma.UserFindManyArgs>",
    );
    expect(files["models.ts"]).toContain("Promise<Prisma.UserGetPayload<T>[]>");
  });

  // The generated app code may reference Prisma's types, but must never pull
  // its runtime in.
  test("imports @prisma/client type-only", () => {
    expect(files["models.ts"]).toContain(
      'import type { Prisma } from "@prisma/client";',
    );
    expect(files["models.ts"]).not.toMatch(
      /^import \{[^}]*\} from "@prisma\/client"/m,
    );
    expect(files["schema.ts"]).not.toContain("@prisma/client");
    expect(files["index.ts"]).not.toContain("@prisma/client");
  });

  test("registers every model by name", () => {
    expect(files["index.ts"]).toContain('register("User", UserModel);');
    expect(files["index.ts"]).toContain('register("Post", PostModel);');
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
   * That is what keeps `Prisma.UserFindManyArgs` describing exactly what the
   * operation accepts — intersecting every args type with a gemi-specific key
   * would make Prisma's own types wrong about our surface. It also keeps the
   * flag away from the compiler, so it cannot reach the plan key, which it must
   * not since it does not change the SQL.
   */
  test("per-call options are a second parameter, leaving Prisma's arg types intact", () => {
    const models = files["models.ts"];

    expect(models).toContain("options?: ExecOptions,");
    expect(models).toContain("type ExecOptions,");
    expect(models).toMatch(/^} from "gemi\/orm";$/m);

    // The args type is Prisma's, unintersected.
    expect(models).toMatch(
      /static findMany<T extends Prisma\.UserFindManyArgs>\(/,
    );
    expect(models).not.toContain("FindManyArgs & {");
  });
});
