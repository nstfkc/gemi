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

/** The full explicit column list `findMany` emits for `user`, unparameterised. */
export const USER_COLUMNS =
  '"id", "publicId", "name", "email", "emailVerifiedAt", "verificationToken", ' +
  '"locale", "globalRole", "password", "organizationId", "createdAt", ' +
  '"updatedAt", "deletedAt"';
