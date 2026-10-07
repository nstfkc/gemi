import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { Application } from "../foundation/Application";
import { Encrypter, EncryptionKeyError } from "../services/encryption/Encrypter";
import {
  assertNoEncryptedFilters,
  currentEncrypter,
  decryptRows,
  encryptWriteArgs,
  encryptedColumnsInRegistry,
  encryptedFields,
} from "./encryption";
import { UnsupportedByDesignError, InvalidArgumentError } from "./errors";
import { Model } from "./Model";
import { clearRegistry, register } from "./registry";
import type { FieldSchema, ModelSchema } from "./schema";

/**
 * The argument-tree half of encrypted columns (#844), with no database: which
 * arguments are refused, and what a write's `data` turns into. The round trip
 * through a real database is `templates/saas-starter/app/models/encrypted-columns.test.ts`.
 */

const scalar = (name: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  column: name,
  type: "String",
  nullable: false,
  isId: false,
  isUpdatedAt: false,
  ...extra,
});

const owner: ModelSchema = {
  name: "Owner",
  table: "Owner",
  fields: { id: scalar("id", { type: "Int", isId: true }), name: scalar("name") },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    credentials: {
      name: "credentials",
      model: "Credential",
      kind: "many",
      relationName: "OwnerToCredential",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

const credential: ModelSchema = {
  name: "Credential",
  table: "Credential",
  fields: {
    id: scalar("id", { type: "Int", isId: true }),
    ownerId: scalar("ownerId", { type: "Int" }),
    label: scalar("label"),
    token: scalar("token", { encrypted: true }),
    refresh: scalar("refresh", { nullable: true, encrypted: true }),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    owner: {
      name: "owner",
      model: "Owner",
      kind: "one",
      relationName: "OwnerToCredential",
      from: ["ownerId"],
      to: ["id"],
      nullable: false,
    },
  },
};

class OwnerModel extends Model {
  static $schema = owner;
}
class CredentialModel extends Model {
  static $schema = credential;
}

let previous: Application | undefined;
const encrypter = new Encrypter({ keys: { k1: randomBytes(32).toString("base64") } });

beforeAll(() => {
  register("Owner", OwnerModel);
  register("Credential", CredentialModel);
  previous = Application.getInstance();
  const application = new Application();
  application.instance(Encrypter, encrypter as never);
  Application.setInstance(application);
});

afterAll(() => {
  clearRegistry();
  if (previous) Application.setInstance(previous);
});

describe("which fields are encrypted", () => {
  test("read off the schema, in declaration order", () => {
    expect(encryptedFields(credential)).toEqual(["token", "refresh"]);
    expect(encryptedFields(owner)).toEqual([]);
  });

  test("every registered encrypted column", () => {
    expect(encryptedColumnsInRegistry()).toEqual(["Credential.token", "Credential.refresh"]);
  });
});

describe("filters on an encrypted column are refused", () => {
  test.each([
    ["equality", "findMany", { where: { token: "x" } }],
    ["an operator", "findMany", { where: { token: { contains: "x" } } }],
    ["inside AND / OR / NOT", "findFirst", { where: { OR: [{ label: "a" }, { NOT: { token: "x" } }] } }],
    ["orderBy", "findMany", { orderBy: [{ label: "asc" }, { token: "desc" }] }],
    ["distinct", "findMany", { distinct: ["token"] }],
    ["an update's where", "updateMany", { where: { refresh: "x" }, data: {} }],
    ["a delete's where", "deleteMany", { where: { token: { in: ["x"] } } }],
    ["groupBy by", "groupBy", { by: ["token"] }],
    ["groupBy having", "groupBy", { by: ["label"], having: { refresh: { not: "x" } } }],
    ["an aggregate _max", "aggregate", { _max: { token: true } }],
  ])("%s", (_label, op, args) => {
    expect(() => assertNoEncryptedFilters(credential, op, args)).toThrow(UnsupportedByDesignError);
  });

  test.each([
    ["a relation filter", { where: { credentials: { some: { token: "x" } } } }],
    ["a relation filter under every", { where: { credentials: { every: { NOT: { refresh: "x" } } } } }],
    ["an include's where", { include: { credentials: { where: { token: "x" } } } }],
    ["an include's orderBy", { include: { credentials: { orderBy: { refresh: "asc" } } } }],
    ["a select's where", { select: { credentials: { where: { token: "x" } } } }],
    ["a _count filter", { include: { _count: { select: { credentials: { where: { token: "x" } } } } } }],
  ])("reaching another model through %s", (_label, args) => {
    expect(() => assertNoEncryptedFilters(owner, "findMany", args)).toThrow(/Credential\.(token|refresh) is an encrypted column/);
  });

  test("a to-one relation filter from the other side", () => {
    // `is` / `isNot` and the bare form both reach the target's where.
    const encryptedOwner: ModelSchema = { ...owner, fields: { ...owner.fields, name: scalar("name", { encrypted: true }) } };
    register("Owner", class extends Model { static $schema = encryptedOwner; });
    try {
      expect(() => assertNoEncryptedFilters(credential, "findMany", { where: { owner: { name: "x" } } })).toThrow(UnsupportedByDesignError);
      expect(() => assertNoEncryptedFilters(credential, "findMany", { where: { owner: { is: { name: "x" } } } })).toThrow(UnsupportedByDesignError);
      expect(() => assertNoEncryptedFilters(credential, "findMany", { orderBy: { owner: { name: "asc" } } })).toThrow(UnsupportedByDesignError);
    } finally {
      register("Owner", OwnerModel);
    }
  });

  test("the message says why and what to do instead", () => {
    expect(() => assertNoEncryptedFilters(credential, "findMany", { where: { token: "x" } })).toThrow(
      /different random ciphertext.*keyed hash/s,
    );
  });

  test.each([
    ["null", { token: null }],
    ["equals null", { refresh: { equals: null } }],
    ["not null", { refresh: { not: null } }],
  ])("a null check is allowed: %s", (_label, where) => {
    expect(() => assertNoEncryptedFilters(credential, "findMany", { where })).not.toThrow();
  });

  test("selecting, counting and filtering other columns is fine", () => {
    expect(() =>
      assertNoEncryptedFilters(credential, "findMany", {
        where: { label: "a", ownerId: 1 },
        select: { token: true, refresh: true },
        orderBy: { label: "asc" },
      }),
    ).not.toThrow();
    expect(() => assertNoEncryptedFilters(credential, "count", { select: { token: true } })).not.toThrow();
    expect(() =>
      assertNoEncryptedFilters(owner, "findMany", { include: { credentials: { select: { token: true } } } }),
    ).not.toThrow();
  });
});

describe("writes", () => {
  test("encrypts this model's columns in data, and leaves the caller's object alone", () => {
    const data = { label: "figma", token: "access", refresh: null, ownerId: 1 };
    const next = encryptWriteArgs(credential, "create", { data });

    expect(next.data).not.toBe(data);
    expect(data.token).toBe("access");
    expect(next.data.label).toBe("figma");
    expect(next.data.refresh).toBeNull();
    expect(encrypter.decrypt(next.data.token)).toBe("access");
    // Same keys in the same order, so the plan key does not change.
    expect(Object.keys(next.data)).toEqual(Object.keys(data));
  });

  test("{ set } and every write operation", () => {
    const update = encryptWriteArgs(credential, "update", { where: { id: 1 }, data: { token: { set: "a" } } });
    expect(encrypter.decrypt(update.data.token.set)).toBe("a");

    const many = encryptWriteArgs(credential, "createMany", { data: [{ token: "a" }, { token: "b" }] });
    expect(many.data.map((row: { token: string }) => encrypter.decrypt(row.token))).toEqual(["a", "b"]);

    const upsert = encryptWriteArgs(credential, "upsert", {
      where: { id: 1 },
      create: { token: "c", ownerId: 1, label: "x" },
      update: { refresh: "d" },
    });
    expect(encrypter.decrypt(upsert.create.token)).toBe("c");
    expect(encrypter.decrypt(upsert.update.refresh)).toBe("d");

    const updateMany = encryptWriteArgs(credential, "updateMany", { where: {}, data: { refresh: "e" } });
    expect(encrypter.decrypt(updateMany.data.refresh)).toBe("e");
  });

  test("args without encrypted values come back unchanged", () => {
    const args = { data: { label: "x" } };
    expect(encryptWriteArgs(credential, "create", args)).toBe(args);
    const owned = { data: { name: "x", credentials: { create: { token: "nested" } } } };
    // Nested writes are encrypted by the child's own $exec, not here.
    expect(encryptWriteArgs(owner, "create", owned)).toBe(owned);
  });

  test("a non-string value is refused", () => {
    expect(() => encryptWriteArgs(credential, "create", { data: { token: 42 } })).toThrow(InvalidArgumentError);
    expect(() => encryptWriteArgs(credential, "update", { data: { token: { increment: 1 } } })).toThrow(
      /takes a string or null/,
    );
  });
});

describe("reads", () => {
  test("decrypts in place, leaving null and other columns", () => {
    const rows = [
      { id: 1, label: "a", token: encrypter.encrypt("one"), refresh: null },
      { id: 2, label: "b", token: encrypter.encrypt("two") },
    ];
    decryptRows(credential, rows);
    expect(rows).toEqual([
      { id: 1, label: "a", token: "one", refresh: null },
      { id: 2, label: "b", token: "two" },
    ]);
  });

  test("a value that does not decrypt throws naming the column, never returns it", () => {
    const rows = [{ id: 1, token: "plaintext-token" }];
    expect(() => decryptRows(credential, rows)).toThrow(/Could not decrypt Credential\.token/);
  });
});

describe("no Encrypter bound", () => {
  test("is a typed error naming the fix", () => {
    const application = Application.getInstance();
    Application.setInstance(new Application());
    try {
      expect(() => currentEncrypter()).toThrow(EncryptionKeyError);
      expect(() => encryptWriteArgs(credential, "create", { data: { token: "x" } })).toThrow(/Encrypter/);
    } finally {
      if (application) Application.setInstance(application);
    }
  });
});
