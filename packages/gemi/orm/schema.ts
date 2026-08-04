// Runtime model metadata: the shape the Prisma generator plugin emits into an
// app's `app/models/generated/schema.ts`, and the only thing the compiler is
// allowed to read identifiers from.
//
// Nothing here is discovered from the database at runtime. It is all generated,
// which is what makes `compile` a pure function and what makes SQL injection
// structurally impossible: every identifier the compiler emits is looked up in
// one of these objects first (see the README's invariant 2).
//
// The generator deliberately emits *more* than the current iteration reads.
// Regenerating an app's artifacts is free; changing the shape of the emitted
// artifact after apps depend on it is not.

/**
 * Bumped whenever the emitted artifact's shape changes in a way the runtime
 * cannot read. Generated `schema.ts` files carry their own literal copy, and
 * `assertSchemaArtifactVersion` compares the two at registration time so a stale
 * `app/models/generated` fails with "run prisma generate" rather than with a
 * `TypeError` five stack frames into the compiler.
 *
 * **`FieldSchema.isList` did not bump it**, and the reason is worth stating
 * because the obvious reading says it should have. The hazard a bump guards
 * against is a *new* artifact read by an *old* runtime, which would see a list
 * column, not know the flag, and treat it as a scalar. That pairing cannot
 * occur: the generator is `bin/orm` and the runtime is `orm/`, both shipped by
 * the same `gemi` package and the same version — a runtime old enough to miss
 * the flag came with a generator that refused to emit the column at all. The
 * reverse pairing, an old artifact on a new runtime, is what `isList` being
 * optional already covers.
 */
export const SCHEMA_ARTIFACT_VERSION = 1;

/**
 * Prisma's scalar types, verbatim. Not SQL types — the mapping from these to a
 * column type is the dialect's business, and it differs (SQLite has no
 * `DateTime` and no `Boolean`).
 */
export type ScalarType =
  | "Int"
  | "String"
  | "DateTime"
  | "Boolean"
  | "Float"
  | "BigInt"
  | "Decimal"
  | "Json"
  | "Bytes";

export type DefaultKind =
  | "autoincrement"
  | "cuid"
  | "uuid"
  | "now"
  | "dbgenerated"
  | "value";

export interface DefaultSpec {
  kind: DefaultKind;
  /** Present only for `kind: "value"` — the literal written in the schema. */
  value?: unknown;
}

export interface FieldSchema {
  /** The field name as an app author writes it: `organizationId`. */
  name: string;
  /** The column name in the database: `@map(...)` if present, else `name`. */
  column: string;
  type: ScalarType;
  nullable: boolean;
  isId: boolean;
  isUpdatedAt: boolean;
  /**
   * A Prisma **scalar list** — `tags String[]`. Postgres only; SQLite has no
   * array type and Prisma refuses the declaration there outright.
   *
   * **A flag beside `type` rather than a `ScalarType` constructor**, and the
   * choice reaches further than it looks. `type` keeps meaning the *element*
   * type, so every `switch (field.type)` already written — `encode`, `decode`,
   * `castParameter`, the lateral strategy's `jsonConverter`, `COMPOSITE_IN_TYPES`
   * — keeps reading correctly and only has to ask this one extra question where
   * a list genuinely differs. A `"String[]"` member of the union would have made
   * every one of those switches silently non-exhaustive instead: no compile
   * error, just a `default:` branch answering for a shape it had never seen.
   *
   * Absent rather than `false` on a non-list field, so an artifact generated
   * before this existed is byte-identical to one generated after it — see the
   * note on `SCHEMA_ARTIFACT_VERSION`, which is deliberately *not* bumped here.
   */
  isList?: boolean;
  /**
   * Set when the field is a Prisma enum. The enum's members are strings on the
   * wire, so `type` is `"String"` and this carries the name for later.
   */
  enum?: string;
  default?: DefaultSpec;
}

export interface RelationSchema {
  /** The field name on the owning model: `accounts`. */
  name: string;
  /** The related model's *name*, resolved through the registry at call time. */
  model: string;
  kind: "one" | "many";
  /**
   * Prisma's relation name, shared by both sides. It is what lets the planner
   * find the other side of a relation whose `from`/`to` live on that side only.
   */
  relationName: string;
  /** Local fields. Empty on the side that does not hold the foreign key. */
  from: string[];
  /** Fields on the related model. Empty on the non-owning side, as above. */
  to: string[];
  nullable: boolean;
  /** Implicit many-to-many join table. Emitted now, unused until iteration 3. */
  joinTable?: {
    table: string;
    a: string;
    b: string;
    /**
     * Which column holds the owner of **this** relation field, for a
     * *self*-referential implicit m-n where `a === b` and the model names
     * cannot say.
     *
     * Prisma assigns the columns by **field name, alphabetically**: the
     * alphabetically-first of the relation's two fields has its owner in `A`.
     * Determined by experiment against a generated client, in both directions,
     * rather than from the docs — the two candidate rules (declaration order
     * and field-name order) disagree only when a schema declares the fields out
     * of alphabetical order, which is exactly the case that would have shipped
     * reversed.
     *
     * Absent for a non-self m-n, where comparing the model names answers it,
     * and absent in artifacts generated before this existed — which is why
     * reading it is optional rather than required. Such an artifact behaves
     * exactly as it did: a self-referential m-n is refused.
     */
    ownerColumn?: "A" | "B";
  };
}

export interface ModelSchema {
  /** Registry key: `"User"`. */
  name: string;
  /** `@@map(...)` if present, else `name`. Never inferred or pluralised. */
  table: string;
  /** Insertion-ordered by schema declaration — this is the `select` order. */
  fields: Record<string, FieldSchema>;
  primaryKey: string[];
  /** Single-field `@unique` and composite `@@unique`, in declaration order. */
  uniques: string[][];
  relations: Record<string, RelationSchema>;
}

export class StaleSchemaArtifactError extends Error {
  constructor(found: number) {
    super(
      `The generated model artifact is version ${found}, but this version of ` +
        `gemi reads version ${SCHEMA_ARTIFACT_VERSION}. Re-run \`prisma generate\` ` +
        `to refresh app/models/generated.`,
    );
    this.name = "StaleSchemaArtifactError";
  }
}

/**
 * Called by the generated `index.ts` with its own artifact version literal.
 */
export function assertSchemaArtifactVersion(version: number): void {
  if (version !== SCHEMA_ARTIFACT_VERSION) {
    throw new StaleSchemaArtifactError(version);
  }
}
