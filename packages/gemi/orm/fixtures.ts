import type { ModelSchema } from "./schema";

// Test fixtures, not part of the public surface: nothing in `orm/index.ts`
// imports this file, so it never reaches a bundle.
//
// `user` is a faithful copy of the `User` model in
// `templates/saas-starter/prisma/schema.prisma` — same fields, same order, same
// types — so the compiler tests assert against the SQL the template actually
// produces. `mapped` covers the `@map` / `@@map` case the template has none of.

export const user: ModelSchema = {
  name: "User",
  table: "User",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    publicId: {
      name: "publicId",
      column: "publicId",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
      default: { kind: "cuid" },
    },
    name: {
      name: "name",
      column: "name",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    email: {
      name: "email",
      column: "email",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    emailVerifiedAt: {
      name: "emailVerifiedAt",
      column: "emailVerifiedAt",
      type: "DateTime",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    verificationToken: {
      name: "verificationToken",
      column: "verificationToken",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    locale: {
      name: "locale",
      column: "locale",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
      default: { kind: "value", value: "en-US" },
    },
    globalRole: {
      name: "globalRole",
      column: "globalRole",
      type: "Int",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
      default: { kind: "value", value: 2 },
    },
    password: {
      name: "password",
      column: "password",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    organizationId: {
      name: "organizationId",
      column: "organizationId",
      type: "Int",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    createdAt: {
      name: "createdAt",
      column: "createdAt",
      type: "DateTime",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
      default: { kind: "now" },
    },
    updatedAt: {
      name: "updatedAt",
      column: "updatedAt",
      type: "DateTime",
      nullable: false,
      isId: false,
      isUpdatedAt: true,
    },
    deletedAt: {
      name: "deletedAt",
      column: "deletedAt",
      type: "DateTime",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [["publicId"], ["email"]],
  relations: {
    organization: {
      name: "organization",
      model: "Organization",
      kind: "one",
      relationName: "OrganizationToUser",
      from: ["organizationId"],
      to: ["id"],
      nullable: true,
    },
    accounts: {
      name: "accounts",
      model: "Account",
      kind: "many",
      relationName: "AccountToUser",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

/**
 * `Account` and `Organization`, copied from the template the same way `user` is.
 * Together the three cover every shape the relation planner has to resolve:
 *
 * - `User.organization` — to-one, and the side that *holds* the foreign key.
 * - `User.accounts` — to-many, and the side that does not: its `from` / `to` are
 *   empty, so the planner has to find `Account.user` through `relationName`.
 * - `Organization.users` — the same, one hop further, for depth.
 */
export const account: ModelSchema = {
  name: "Account",
  table: "Account",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    publicId: {
      name: "publicId",
      column: "publicId",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
      default: { kind: "cuid" },
    },
    organizationId: {
      name: "organizationId",
      column: "organizationId",
      type: "Int",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    organizationRole: {
      name: "organizationRole",
      column: "organizationRole",
      type: "Int",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
      default: { kind: "value", value: 2 },
    },
    userId: {
      name: "userId",
      column: "userId",
      type: "Int",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    createdAt: {
      name: "createdAt",
      column: "createdAt",
      type: "DateTime",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
      default: { kind: "now" },
    },
    updatedAt: {
      name: "updatedAt",
      column: "updatedAt",
      type: "DateTime",
      nullable: false,
      isId: false,
      isUpdatedAt: true,
    },
    deletedAt: {
      name: "deletedAt",
      column: "deletedAt",
      type: "DateTime",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [["publicId"]],
  relations: {
    organization: {
      name: "organization",
      model: "Organization",
      kind: "one",
      relationName: "AccountToOrganization",
      from: ["organizationId"],
      to: ["id"],
      nullable: true,
    },
    user: {
      name: "user",
      model: "User",
      kind: "one",
      relationName: "AccountToUser",
      from: ["userId"],
      to: ["id"],
      nullable: true,
    },
  },
};

export const organization: ModelSchema = {
  name: "Organization",
  table: "Organization",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    publicId: {
      name: "publicId",
      column: "publicId",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
      default: { kind: "cuid" },
    },
    name: {
      name: "name",
      column: "name",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
    logoUrl: {
      name: "logoUrl",
      column: "logoUrl",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    description: {
      name: "description",
      column: "description",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [["publicId"]],
  relations: {
    users: {
      name: "users",
      model: "User",
      kind: "many",
      relationName: "OrganizationToUser",
      from: [],
      to: [],
      nullable: false,
    },
    accounts: {
      name: "accounts",
      model: "Account",
      kind: "many",
      relationName: "AccountToOrganization",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

/**
 * An implicit many-to-many pair, which the template's schema cannot express —
 * every relation there is 1-1 or 1-n. Prisma gives an implicit m-n no join
 * *model*: just a `_PostToTag` table with an `A` and a `B` column, the two
 * models in alphabetical order. Neither side holds a foreign key.
 *
 * `templates/saas-starter/app/models/relations.many-to-many.test.ts` builds a
 * real SQLite database from these and runs the ORM against it.
 */
export const post: ModelSchema = {
  name: "Post",
  table: "Post",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    title: {
      name: "title",
      column: "title",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    tags: {
      name: "tags",
      model: "Tag",
      kind: "many",
      relationName: "PostToTag",
      from: [],
      to: [],
      nullable: false,
      joinTable: { table: "_PostToTag", a: "Post", b: "Tag" },
    },
  },
};

export const tag: ModelSchema = {
  name: "Tag",
  table: "Tag",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    label: {
      name: "label",
      column: "label",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    posts: {
      name: "posts",
      model: "Post",
      kind: "many",
      relationName: "PostToTag",
      from: [],
      to: [],
      nullable: false,
      joinTable: { table: "_PostToTag", a: "Post", b: "Tag" },
    },
  },
};

/**
 * A **multi-field relation** — `@relation(fields: [tenantId, ledgerCode],
 * references: [tenantId, code])` — which the template's schema has no example
 * of and Prisma allows.
 *
 * The shape is not exotic: it is what a tenant-scoped schema looks like when
 * every table carries `tenantId` and every relation joins on
 * `(tenantId, parentId)`. An application written that way cannot use `include`
 * at all today, which is what #67 is about.
 *
 * These exist so the *refusal* can be tested on every surface that correlates
 * over a relation. Until the feature lands, the property worth holding is that
 * none of them quietly joins on the first field.
 */
export const ledger: ModelSchema = {
  name: "Ledger",
  table: "Ledger",
  fields: {
    tenantId: {
      name: "tenantId",
      column: "tenantId",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
    },
    code: {
      name: "code",
      column: "code",
      type: "String",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
    },
    title: {
      name: "title",
      column: "title",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["tenantId", "code"],
  uniques: [],
  relations: {
    entries: {
      name: "entries",
      model: "LedgerEntry",
      kind: "many",
      relationName: "LedgerToEntry",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

/** The owning side of {@link ledger}'s two-field relation. */
export const ledgerEntry: ModelSchema = {
  name: "LedgerEntry",
  table: "LedgerEntry",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    tenantId: {
      name: "tenantId",
      column: "tenantId",
      type: "Int",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
    ledgerCode: {
      name: "ledgerCode",
      column: "ledgerCode",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
    amount: {
      name: "amount",
      column: "amount",
      type: "Int",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    ledger: {
      name: "ledger",
      model: "Ledger",
      kind: "one",
      relationName: "LedgerToEntry",
      from: ["tenantId", "ledgerCode"],
      to: ["tenantId", "code"],
      nullable: false,
    },
  },
};

/**
 * The **optional** composite key — the same two columns as {@link ledgerEntry},
 * nullable (#271).
 *
 * `ledgerEntry`'s is required, which is the ordinary tenant-scoped shape, and
 * Prisma leaves `disconnect` out of a required relation's nested input type
 * entirely. So every operand that *detaches* a composite link — `disconnect`,
 * `set`, and the branches of `connect` / `create` / `connectOrCreate` that
 * displace an incumbent — was unreachable from these fixtures, in the same way
 * the foreign side of a to-one was unreachable before {@link profile}.
 *
 * Both columns are optional together, which is Prisma's rule rather than a
 * choice here: *"The fields of a relation must either all be optional or all be
 * required"*. `assertDisconnectable` and the two `displaces` predicates test
 * every column and expect one answer, and this is the shape that gives it.
 */
export const ledgerNote: ModelSchema = {
  name: "LedgerNote",
  table: "LedgerNote",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    tenantId: {
      name: "tenantId",
      column: "tenantId",
      type: "Int",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    ledgerCode: {
      name: "ledgerCode",
      column: "ledgerCode",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    body: {
      name: "body",
      column: "body",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    ledger: {
      name: "ledger",
      model: "Ledger",
      kind: "one",
      relationName: "LedgerToLedgerNote",
      from: ["tenantId", "ledgerCode"],
      to: ["tenantId", "code"],
      nullable: true,
    },
  },
};

/**
 * A composite **one-to-one** — {@link ledgerNote}'s columns plus the
 * `@@unique` covering exactly them, which is what makes the far row hold one
 * partner.
 *
 * {@link profile} is the single-field version of this shape. Over one column
 * *"the index covers exactly the relation's fields"* and *"the index is one
 * column"* are the same sentence; here they are not, which is the whole reason
 * this fixture exists.
 *
 * `uniques: [["tenantId", "ledgerCode"]]` is the group Prisma requires — and
 * the only one it accepts, measured on 6.19.2: both a wider
 * `@@unique([tenantId, ledgerCode, seal])` and a reordered
 * `@@unique([ledgerCode, tenantId])` are refused at parse time with P1012,
 * *"Either add an `@@unique([tenantId, ledgerCode])` attribute to the model, or
 * change the relation to one-to-many"*.
 */
export const ledgerSeal: ModelSchema = {
  name: "LedgerSeal",
  table: "LedgerSeal",
  fields: {
    id: ledgerNote.fields.id,
    tenantId: ledgerNote.fields.tenantId,
    ledgerCode: ledgerNote.fields.ledgerCode,
    seal: {
      name: "seal",
      column: "seal",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [["tenantId", "ledgerCode"]],
  relations: {
    ledger: {
      name: "ledger",
      model: "Ledger",
      kind: "one",
      relationName: "LedgerToLedgerSeal",
      from: ["tenantId", "ledgerCode"],
      to: ["tenantId", "code"],
      nullable: true,
    },
  },
};

/**
 * `ledger`, plus the far sides of {@link ledgerNote} and {@link ledgerSeal}.
 *
 * A separate export rather than an edit to `ledger` for the reason
 * {@link userWithProfile} is: the read suites count that model's relations, and
 * a fixture that grew two would change what they assert without saying so.
 *
 * `seal` is `kind: "one"`, which is the *foreign* side's whole displacement
 * discriminator — P1012 gives that a non-list back-relation implies the child's
 * key is unique, and that implication holds over a composite `@@unique` exactly
 * as it does over a single-column one. Measured on 6.19.2 rather than assumed:
 * `prisma validate` accepts `LedgerSeal.@@unique([tenantId, ledgerCode])`
 * beside `Ledger.seal LedgerSeal?`.
 */
export const ledgerWithOptional: ModelSchema = {
  ...ledger,
  relations: {
    ...ledger.relations,
    notes: {
      name: "notes",
      model: "LedgerNote",
      kind: "many",
      relationName: "LedgerToLedgerNote",
      from: [],
      to: [],
      nullable: false,
    },
    seal: {
      name: "seal",
      model: "LedgerSeal",
      kind: "one",
      relationName: "LedgerToLedgerSeal",
      from: [],
      to: [],
      nullable: true,
    },
  },
};

/**
 * **A composite key whose columns disagree about being optional** — `tenantId`
 * nullable beside a required `ledgerCode` (#271).
 *
 * Prisma cannot produce this: *"The fields of a relation must either all be
 * optional or all be required"*, so every schema it validates has columns that
 * agree and the first one answers for all of them. That is exactly why the
 * three "every column" *nullability* tests — `planOwningSide`'s `displaces`,
 * `planForeignSide`'s `displaces`, and `assertDisconnectable` — had no case
 * that could tell them from their single-field spellings, and the first review
 * of #271 said so.
 *
 * A hand-built `ModelSchema` is the one thing that can, and this is where a
 * hand-built `ModelSchema` lives. **The nullable column is deliberately
 * first**: `[fields[0]]` is the mutation these three predicates collapse to,
 * and over `(nullable, required)` that mutation answers *"detachable"* where
 * the whole tuple answers *"not"* — so a test written against this fixture goes
 * red when any of the three is narrowed, and green only on the real thing.
 *
 * `uniques` covers exactly the relation's fields, so the *index* half of the
 * owning side's `displaces` is satisfied and the nullability half is the only
 * thing left deciding — otherwise the case would pass for the wrong reason.
 */
export const ledgerSealMixed: ModelSchema = {
  name: "LedgerSealMixed",
  table: "LedgerSealMixed",
  fields: {
    id: ledgerNote.fields.id,
    tenantId: ledgerNote.fields.tenantId,
    ledgerCode: { ...ledgerNote.fields.ledgerCode, nullable: false },
    seal: ledgerSeal.fields.seal,
  },
  primaryKey: ["id"],
  uniques: [["tenantId", "ledgerCode"]],
  relations: {
    ledger: {
      name: "ledger",
      model: "Ledger",
      kind: "one",
      relationName: "LedgerToLedgerSealMixed",
      from: ["tenantId", "ledgerCode"],
      to: ["tenantId", "code"],
      nullable: true,
    },
  },
};

/**
 * **Two composite relations that share a foreign-key column** — the shape #271
 * makes reachable and the first review of it caught (#386).
 *
 * `prisma validate` accepts this on 6.19.2. Before #271 both relations were
 * refused by name for their width, so no call could write through both at
 * once; now both compile, both contribute a `tenantId`, and `insertColumns`
 * folds contributions through a `Map` keyed by field — so without the guard in
 * `planNestedWrites` the alphabetically-last relation would silently decide the
 * shared column, where Prisma lets the caller's last `data` key decide it.
 *
 * `ledgerCode` and `noteCode` are the columns the two relations do *not* share,
 * which is what makes the divergence a wrong row rather than a wrong error:
 * both links are plausible, and only one of the two `tenantId`s is right.
 */
export const ledgerCrossEntry: ModelSchema = {
  name: "LedgerCrossEntry",
  table: "LedgerCrossEntry",
  fields: {
    id: ledgerEntry.fields.id,
    tenantId: ledgerEntry.fields.tenantId,
    ledgerCode: ledgerEntry.fields.ledgerCode,
    noteCode: {
      name: "noteCode",
      column: "noteCode",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
    amount: ledgerEntry.fields.amount,
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    ledger: {
      name: "ledger",
      model: "Ledger",
      kind: "one",
      relationName: "LedgerToCrossEntry",
      from: ["tenantId", "ledgerCode"],
      to: ["tenantId", "code"],
      nullable: false,
    },
    note: {
      name: "note",
      model: "Ledger",
      kind: "one",
      relationName: "NoteToCrossEntry",
      from: ["tenantId", "noteCode"],
      to: ["tenantId", "code"],
      nullable: false,
    },
  },
};

/**
 * `ledgerWithOptional`, plus the far sides of {@link ledgerSealMixed} and
 * {@link ledgerCrossEntry}.
 *
 * A third variant rather than an edit, for the reason {@link ledgerWithOptional}
 * is a second one: the suites that count a fixture's relations should not have
 * to move every time a case needs one more back-reference.
 *
 * `sealMixed` is `kind: "one"` so that the *foreign* side's `displaces` reaches
 * its nullability test — with `kind: "many"` the predicate short-circuits and
 * the column check is never evaluated, which would pin nothing.
 */
export const ledgerWithMixed: ModelSchema = {
  ...ledgerWithOptional,
  relations: {
    ...ledgerWithOptional.relations,
    sealMixed: {
      name: "sealMixed",
      model: "LedgerSealMixed",
      kind: "one",
      relationName: "LedgerToLedgerSealMixed",
      from: [],
      to: [],
      nullable: true,
    },
    crossEntries: {
      name: "crossEntries",
      model: "LedgerCrossEntry",
      kind: "many",
      relationName: "LedgerToCrossEntry",
      from: [],
      to: [],
      nullable: false,
    },
    crossNotes: {
      name: "crossNotes",
      model: "LedgerCrossEntry",
      kind: "many",
      relationName: "NoteToCrossEntry",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

/**
 * A self-relation — the one topology where the parent and the child are the same
 * table, which the template's schema has no example of.
 *
 * It exists for the lateral strategy's decline: a correlation is written as
 * `"<child>"."<fk>" = "<parent>"."<pk>"`, and when both names are `"Category"`
 * that compares the subquery's own row against itself rather than against the
 * outer one. Batching is unaffected, because it stitches in JavaScript.
 */
export const category: ModelSchema = {
  name: "Category",
  table: "Category",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    name: {
      name: "name",
      column: "name",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
    parentId: {
      name: "parentId",
      column: "parentId",
      type: "Int",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    parent: {
      name: "parent",
      model: "Category",
      kind: "one",
      relationName: "CategoryTree",
      from: ["parentId"],
      to: ["id"],
      nullable: true,
    },
    children: {
      name: "children",
      model: "Category",
      kind: "many",
      relationName: "CategoryTree",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

/**
 * A model whose primary key is a **compound `@@id`**, and which declares no
 * `@@unique`.
 *
 * The template's only compound key is `SocialAccount`'s
 * `@@unique([username, provider])`, which is a different path — so a compound
 * *primary* key had no coverage anywhere, and was unreachable by key at all.
 * See #80.
 */
export const membership: ModelSchema = {
  name: "Membership",
  table: "Membership",
  fields: {
    organizationId: {
      name: "organizationId",
      column: "organizationId",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
    },
    userId: {
      name: "userId",
      column: "userId",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
    },
    role: {
      name: "role",
      column: "role",
      type: "Int",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
      default: { kind: "value", value: 2 },
    },
  },
  primaryKey: ["organizationId", "userId"],
  uniques: [],
  relations: {},
};

/** `@@map("audit_log")` with `@map`ped columns, plus every decoded scalar type. */
export const mapped: ModelSchema = {
  name: "AuditLog",
  table: "audit_log",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
    },
    isArchived: {
      name: "isArchived",
      column: "is_archived",
      type: "Boolean",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
    occurredAt: {
      name: "occurredAt",
      column: "occurred_at",
      type: "DateTime",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
    payload: {
      name: "payload",
      column: "payload",
      type: "Json",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    size: {
      name: "size",
      column: "size",
      type: "BigInt",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {},
};

/**
 * A model whose unique key is a `DateTime`, which the template's schema has no
 * example of.
 *
 * It exists for one asymmetry: `encode` passes a `Date` straight through on
 * Postgres and turns it into a number on SQLite, so an `upsert` comparing its
 * conflict key by identity works on one dialect and refuses a correct call on
 * the other. `Bytes` has the same shape on both.
 */
export const reading: ModelSchema = {
  name: "Reading",
  table: "Reading",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    at: {
      name: "at",
      column: "at",
      type: "DateTime",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
    digest: {
      name: "digest",
      column: "digest",
      type: "Bytes",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    value: {
      name: "value",
      column: "value",
      type: "Float",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [["at"]],
  relations: {},
};

/**
 * A model where every field is autoincrement, database-defaulted or nullable,
 * and none has a *client-side* default.
 *
 * So a `create({ data: {} })` writes no column at all — the `default values`
 * case — and a `createMany` of empty rows has no column list to repeat. Not
 * reachable from the template's schema, where `@default(cuid())` on `publicId`
 * puts a client-side value in every model.
 */
export const bare: ModelSchema = {
  name: "Bare",
  table: "Bare",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    note: {
      name: "note",
      column: "note",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {},
};

/**
 * A one-to-one whose foreign key lives on the **child**, which nothing else
 * here has:
 *
 *     model User    { profile Profile? }
 *     model Profile { userId Int @unique
 *                     user   User @relation(fields: [userId], references: [id]) }
 *
 * Every other to-one in these fixtures holds its own key, so `planForeignSide`
 * was only ever reached with `kind: "many"` — and it has exactly one `kind`
 * check, which is why every other operand treated the child as a list (#116).
 *
 * `userWithProfile` rather than adding the relation to `user`: the emitted
 * column list is asserted verbatim in several tests, and a relation adds no
 * column but the fixture is compared as a whole in others.
 */
export const profile: ModelSchema = {
  name: "Profile",
  table: "Profile",
  fields: {
    id: {
      name: "id",
      column: "id",
      type: "Int",
      nullable: false,
      isId: true,
      isUpdatedAt: false,
      default: { kind: "autoincrement" },
    },
    bio: {
      name: "bio",
      column: "bio",
      type: "String",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
    // Required and unique — that pairing is what makes the relation a to-one
    // rather than a to-many, and `@unique` is what Prisma requires for it.
    userId: {
      name: "userId",
      column: "userId",
      type: "Int",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
    },
  },
  primaryKey: ["id"],
  uniques: [["userId"]],
  relations: {
    user: {
      name: "user",
      model: "User",
      kind: "one",
      relationName: "ProfileToUser",
      from: ["userId"],
      to: ["id"],
      nullable: false,
    },
  },
};

/**
 * `user`, plus the far side of {@link profile} — `kind: "one"` with empty
 * `from`/`to`, which is how the foreign side of any relation is spelled: the
 * link is resolved through the child's opposing relation, not stated here.
 *
 * **...and `metadata Json?`, which is the schema `corpus.ts` is compiled
 * against.** A `where: { … : { path: …, equals: … } }` entry needs a Json
 * column: aimed at anything else it is refused — *"A 'path' filter reads inside
 * a JSON document, and 'name' is a String column"* — and the invariant suites
 * track refusals rather than swallowing them, so the corpus could not carry a
 * JSON path filter at all until some fixture grew one (#301). That refusal is
 * itself a corpus entry now; what it could not be was the only one.
 *
 * Here rather than on `user` for the reason the `profile` relation is here:
 * `user` is a faithful copy of the template's `User` *as the read tests assert
 * it*, and {@link USER_COLUMNS} is spelled out in several of them. The template
 * schema does declare `metadata Json?` on `User`, so this is the fixture moving
 * *toward* the real model rather than away from it — `user` is the one that has
 * drifted, and re-baselining it is not this change's business.
 */
export const userWithProfile: ModelSchema = {
  ...user,
  fields: {
    ...user.fields,
    metadata: {
      name: "metadata",
      column: "metadata",
      type: "Json",
      nullable: true,
      isId: false,
      isUpdatedAt: false,
    },
  },
  relations: {
    ...user.relations,
    profile: {
      name: "profile",
      model: "Profile",
      kind: "one",
      relationName: "ProfileToUser",
      from: [],
      to: [],
      nullable: true,
    },
  },
};

/** The full explicit column list `findMany` emits for `user`, unparameterised. */
export const USER_COLUMNS =
  '"id", "publicId", "name", "email", "emailVerifiedAt", "verificationToken", ' +
  '"locale", "globalRole", "password", "organizationId", "createdAt", ' +
  '"updatedAt", "deletedAt"';
