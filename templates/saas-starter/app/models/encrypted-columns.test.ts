import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  DecryptionError,
  Model,
  UnsupportedByDesignError,
  clearPlanCache,
  register,
  rotateEncryptedColumns,
  type ModelSchema,
} from "gemi/orm";
import { Encrypter } from "gemi/services";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./scratch";

/**
 * Encrypted columns (#844) against a real database: a `/// @gemi.encrypted`
 * column is ciphertext in the table and plaintext in every result — find,
 * select, include under both relation strategies, nested writes, every write
 * operation — and a key rotation keeps old rows readable until
 * `encryption:rotate` moves them.
 *
 * The models are declared here rather than in `schema.prisma`, with the
 * metadata the generator emits for
 *
 *     model EncOwner      { id Int @id @default(autoincrement())  name String  credentials EncCredential[] }
 *     model EncCredential {
 *       id Int @id @default(autoincrement())
 *       ownerId Int
 *       owner EncOwner @relation(fields: [ownerId], references: [id])
 *       label String
 *       /// @gemi.encrypted
 *       token String
 *       /// @gemi.encrypted
 *       refresh String?
 *     }
 */

const ownerSchema: ModelSchema = {
  name: "EncOwner",
  table: "EncOwner",
  fields: {
    id: { name: "id", column: "id", type: "Int", nullable: false, isId: true, isUpdatedAt: false, default: { kind: "autoincrement" } },
    name: { name: "name", column: "name", type: "String", nullable: false, isId: false, isUpdatedAt: false },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    credentials: { name: "credentials", model: "EncCredential", kind: "many", relationName: "EncOwnerToEncCredential", from: [], to: [], nullable: false },
  },
};

const credentialSchema: ModelSchema = {
  name: "EncCredential",
  table: "EncCredential",
  fields: {
    id: { name: "id", column: "id", type: "Int", nullable: false, isId: true, isUpdatedAt: false, default: { kind: "autoincrement" } },
    ownerId: { name: "ownerId", column: "ownerId", type: "Int", nullable: false, isId: false, isUpdatedAt: false },
    label: { name: "label", column: "label", type: "String", nullable: false, isId: false, isUpdatedAt: false },
    token: { name: "token", column: "token", type: "String", nullable: false, isId: false, isUpdatedAt: false, encrypted: true },
    refresh: { name: "refresh", column: "refresh", type: "String", nullable: true, isId: false, isUpdatedAt: false, encrypted: true },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    owner: { name: "owner", model: "EncOwner", kind: "one", relationName: "EncOwnerToEncCredential", from: ["ownerId"], to: ["id"], nullable: false },
  },
};

/** The operations a generated base would carry, as one-line delegations to `$exec`. */
type Args = Record<string, unknown>;
type Options = Record<string, unknown> | undefined;
abstract class Ops extends Model {
  static findMany(args?: Args, options?: Options) { return this.$exec("findMany", args, options as never); }
  static findFirst(args?: Args, options?: Options) { return this.$exec("findFirst", args, options as never); }
  static findFirstOrThrow(args?: Args, options?: Options) { return this.$exec("findFirstOrThrow", args, options as never); }
  static findUnique(args: Args, options?: Options) { return this.$exec("findUnique", args, options as never); }
  static findUniqueOrThrow(args: Args, options?: Options) { return this.$exec("findUniqueOrThrow", args, options as never); }
  static create(args: Args) { return this.$exec("create", args); }
  static createMany(args: Args) { return this.$exec("createMany", args); }
  static update(args: Args) { return this.$exec("update", args); }
  static updateMany(args: Args) { return this.$exec("updateMany", args); }
  static upsert(args: Args) { return this.$exec("upsert", args); }
  static delete(args: Args) { return this.$exec("delete", args); }
}

class EncOwner extends Ops {
  static $schema = ownerSchema;
}
class EncCredential extends Ops {
  static $schema = credentialSchema;
}

const DDL = {
  sqlite: [
    `CREATE TABLE "EncOwner" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL)`,
    `CREATE TABLE "EncCredential" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "ownerId" INTEGER NOT NULL REFERENCES "EncOwner"("id"), "label" TEXT NOT NULL, "token" TEXT NOT NULL, "refresh" TEXT)`,
  ],
  postgres: [
    `DROP TABLE IF EXISTS "EncCredential"`,
    `DROP TABLE IF EXISTS "EncOwner"`,
    `CREATE TABLE "EncOwner" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL)`,
    `CREATE TABLE "EncCredential" ("id" SERIAL PRIMARY KEY, "ownerId" INTEGER NOT NULL REFERENCES "EncOwner"("id"), "label" TEXT NOT NULL, "token" TEXT NOT NULL, "refresh" TEXT)`,
  ],
};

const STRATEGIES = ["batched", "lateral"] as const;
const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;
    let application: Application;
    let owner: number;

    const useKeys = (config: ConstructorParameters<typeof Encrypter>[0]) => {
      application.instance(Encrypter, new Encrypter(config) as never);
    };

    const stored = async (id: number) =>
      (await raw.unsafe(`SELECT "token", "refresh" FROM "EncCredential" WHERE "id" = ${Number(id)}`))[0] as {
        token: string;
        refresh: string | null;
      };

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-encrypted-"));
        target = `sqlite://${join(workspace, "encrypted.db")}`;
      }
      database = new DatabaseManager({ url: target });
      raw = new SQL(target);
      for (const statement of url ? DDL.postgres : DDL.sqlite) await raw.unsafe(statement);

      previous = Application.getInstance();
      application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      if (url) {
        await raw.unsafe(`DROP TABLE IF EXISTS "EncCredential"`);
        await raw.unsafe(`DROP TABLE IF EXISTS "EncOwner"`);
      }
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      register("EncOwner", EncOwner);
      register("EncCredential", EncCredential);
      useKeys({ keys: { k1 } });
      await raw.unsafe(`DELETE FROM "EncCredential"`);
      await raw.unsafe(`DELETE FROM "EncOwner"`);
      owner = ((await EncOwner.create({ data: { name: "ada" } })) as { id: number }).id;
    });

    const createCredential = (data: Record<string, unknown> = {}) =>
      EncCredential.create({
        data: { ownerId: owner, label: "figma", token: "access-1", refresh: "refresh-1", ...data },
      }) as Promise<Record<string, any>>;

    describe("at rest", () => {
      test("create stores envelopes and returns the plaintext", async () => {
        const created = await createCredential();
        expect(created).toMatchObject({ label: "figma", token: "access-1", refresh: "refresh-1" });

        const row = await stored(created.id);
        expect(row.token).toMatch(/^v1:k1:/);
        expect(row.refresh).toMatch(/^v1:k1:/);
        expect(row.token).not.toContain("access-1");
      });

      test("null stays NULL", async () => {
        const created = await createCredential({ refresh: null });
        expect(created.refresh).toBeNull();
        expect((await stored(created.id)).refresh).toBeNull();
      });
    });

    describe("every read path decrypts", () => {
      test("findMany, findFirst, findUnique and the OrThrow forms", async () => {
        const { id } = await createCredential();
        expect(await EncCredential.findMany({})).toMatchObject([{ token: "access-1" }]);
        expect(await EncCredential.findFirst({ where: { label: "figma" } })).toMatchObject({ token: "access-1" });
        expect(await EncCredential.findUnique({ where: { id } })).toMatchObject({ refresh: "refresh-1" });
        expect(await EncCredential.findUniqueOrThrow({ where: { id } })).toMatchObject({ token: "access-1" });
        expect(await EncCredential.findFirstOrThrow({})).toMatchObject({ token: "access-1" });
      });

      test("select", async () => {
        await createCredential();
        expect(await EncCredential.findMany({ select: { token: true } })).toEqual([{ token: "access-1" }]);
        expect(await EncCredential.findMany({ select: { label: true } })).toEqual([{ label: "figma" }]);
      });

      for (const strategy of STRATEGIES) {
        test(`an include (${strategy})`, async () => {
          await createCredential();
          const owners = (await EncOwner.findMany(
            { include: { credentials: { select: { token: true, refresh: true } } } },
            { strategy },
          )) as any[];
          expect(owners[0].credentials).toEqual([{ token: "access-1", refresh: "refresh-1" }]);
        });

        test(`a to-one include from the child (${strategy})`, async () => {
          await createCredential();
          const rows = (await EncCredential.findMany({ include: { owner: true } }, { strategy })) as any[];
          expect(rows[0]).toMatchObject({ token: "access-1", owner: { name: "ada" } });
        });
      }

      test("a tracked row snapshots the plaintext, so save writes only what changed", async () => {
        const { id } = await createCredential();
        const row = (await EncCredential.findUnique({ where: { id } }, { track: true })) as any;
        expect(row.token).toBe("access-1");

        row.token = "access-2";
        const saved = (await EncCredential.save(row)) as any;
        expect(saved.token).toBe("access-2");
        expect((await stored(id)).token).toMatch(/^v1:k1:/);
        expect(((await EncCredential.findUnique({ where: { id } })) as any).token).toBe("access-2");
        expect(await EncCredential.save(row)).toBeNull();
      });
    });

    describe("every write path encrypts", () => {
      test("update, { set } and updateMany", async () => {
        const { id } = await createCredential();
        const updated = (await EncCredential.update({ where: { id }, data: { token: { set: "access-2" } } })) as any;
        expect(updated.token).toBe("access-2");
        await EncCredential.updateMany({ where: { label: "figma" }, data: { refresh: "refresh-2" } });

        const row = await stored(id);
        expect(row.token).toMatch(/^v1:k1:/);
        expect(row.refresh).toMatch(/^v1:k1:/);
        expect(await EncCredential.findUnique({ where: { id } })).toMatchObject({ token: "access-2", refresh: "refresh-2" });
      });

      test("upsert, both branches", async () => {
        const created = (await EncCredential.upsert({
          where: { id: 999 },
          create: { ownerId: owner, label: "u", token: "created" },
          update: { token: "updated" },
        })) as any;
        expect(created.token).toBe("created");
        const updated = (await EncCredential.upsert({
          where: { id: created.id },
          create: { ownerId: owner, label: "u", token: "created" },
          update: { token: "updated" },
        })) as any;
        expect(updated.token).toBe("updated");
        expect((await stored(created.id)).token).toMatch(/^v1:k1:/);
      });

      test("createMany", async () => {
        await EncCredential.createMany({
          data: [
            { ownerId: owner, label: "a", token: "t-a" },
            { ownerId: owner, label: "b", token: "t-b", refresh: "r-b" },
          ],
        });
        const rows = (await EncCredential.findMany({ orderBy: { label: "asc" } })) as any[];
        expect(rows.map((row) => [row.token, row.refresh])).toEqual([
          ["t-a", null],
          ["t-b", "r-b"],
        ]);
        for (const row of rows) expect((await stored(row.id)).token).toMatch(/^v1:k1:/);
      });

      test("a nested create through the parent", async () => {
        const created = (await EncOwner.create({
          data: { name: "grace", credentials: { create: [{ label: "n", token: "nested" }] } },
          include: { credentials: true },
        })) as any;
        expect(created.credentials[0].token).toBe("nested");
        expect((await stored(created.credentials[0].id)).token).toMatch(/^v1:k1:/);
      });

      test("delete returns the plaintext row", async () => {
        const { id } = await createCredential();
        expect(await EncCredential.delete({ where: { id } })).toMatchObject({ token: "access-1" });
      });
    });

    describe("filters are refused, null checks are not", () => {
      test("where, orderBy and a relation filter", async () => {
        await createCredential();
        await expect(EncCredential.findMany({ where: { token: "access-1" } })).rejects.toThrow(UnsupportedByDesignError);
        await expect(EncCredential.findMany({ orderBy: { token: "asc" } })).rejects.toThrow(UnsupportedByDesignError);
        await expect(
          EncOwner.findMany({ where: { credentials: { some: { token: "access-1" } } } }),
        ).rejects.toThrow(/EncCredential\.token is an encrypted column/);
      });

      test("is null / is not null", async () => {
        await createCredential({ label: "with" });
        await createCredential({ label: "without", refresh: null });
        expect(((await EncCredential.findMany({ where: { refresh: null } })) as any[]).map((row) => row.label)).toEqual(["without"]);
        expect(
          ((await EncCredential.findMany({ where: { refresh: { not: null } } })) as any[]).map((row) => row.label),
        ).toEqual(["with"]);
      });
    });

    describe("a value that does not decrypt", () => {
      test("is an error, never the ciphertext", async () => {
        const { id } = await createCredential();
        await raw.unsafe(`UPDATE "EncCredential" SET "token" = 'not-an-envelope' WHERE "id" = ${Number(id)}`);
        await expect(EncCredential.findUnique({ where: { id } })).rejects.toThrow(DecryptionError);
      });

      test("including one written under a key that is no longer configured", async () => {
        await createCredential();
        useKeys({ keys: { k2 } });
        const error = await EncCredential.findMany({}).catch((caught) => caught);
        expect(error).toBeInstanceOf(DecryptionError);
        expect(error.reason).toBe("unknown_key");
        expect(error.column).toEqual({ model: "EncCredential", field: "token" });
      });
    });

    describe("key rotation", () => {
      test("old rows still read under the new key; rotate moves them; then the old key can go", async () => {
        const a = await createCredential({ label: "a" });
        const b = await createCredential({ label: "b", refresh: null });

        useKeys({ keys: { k1, k2 }, current: "k2" });
        expect(((await EncCredential.findUnique({ where: { id: a.id } })) as any).token).toBe("access-1");
        const c = await createCredential({ label: "c" });
        expect((await stored(c.id)).token).toMatch(/^v1:k2:/);

        const dry = await rotateEncryptedColumns("EncCredential", { dryRun: true });
        expect(dry).toMatchObject({ scanned: 3, rotated: 2 });
        expect((await stored(a.id)).token).toMatch(/^v1:k1:/);

        const report = await rotateEncryptedColumns("EncCredential", { batchSize: 1 });
        expect(report).toMatchObject({ model: "EncCredential", fields: ["token", "refresh"], scanned: 3, rotated: 2, skipped: 0 });
        for (const id of [a.id, b.id, c.id]) expect((await stored(id)).token).toMatch(/^v1:k2:/);
        expect((await stored(a.id)).refresh).toMatch(/^v1:k2:/);
        expect((await stored(b.id)).refresh).toBeNull();

        expect(await rotateEncryptedColumns("EncCredential")).toMatchObject({ rotated: 0 });

        useKeys({ keys: { k2 } });
        expect(((await EncCredential.findMany({ orderBy: { label: "asc" } })) as any[]).map((row) => row.token)).toEqual([
          "access-1",
          "access-1",
          "access-1",
        ]);
      });

      test("plaintext left from before the column was encrypted is reported, and encrypted on request", async () => {
        const { id } = await createCredential();
        await raw.unsafe(`UPDATE "EncCredential" SET "token" = 'legacy-plain' WHERE "id" = ${Number(id)}`);

        expect(await rotateEncryptedColumns("EncCredential")).toMatchObject({ rotated: 0, plaintext: 1 });
        expect((await stored(id)).token).toBe("legacy-plain");

        expect(await rotateEncryptedColumns("EncCredential", { encryptPlaintext: true })).toMatchObject({ rotated: 1 });
        expect(((await EncCredential.findUnique({ where: { id } })) as any).token).toBe("legacy-plain");
      });
    });
  });
}

suite("encrypted columns (sqlite)");

if (POSTGRES_URL) {
  suite("encrypted columns (postgres)", POSTGRES_URL);
} else {
  describe("encrypted columns (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
