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

/** The full explicit column list `findMany` emits for `user`, unparameterised. */
export const USER_COLUMNS =
  '"id", "publicId", "name", "email", "emailVerifiedAt", "verificationToken", ' +
  '"locale", "globalRole", "password", "organizationId", "createdAt", ' +
  '"updatedAt", "deletedAt"';
