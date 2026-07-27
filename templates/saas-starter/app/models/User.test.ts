import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { UnsupportedQueryError, clearPlanCache, planCacheStats } from "gemi/orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { User } from "./User";

// The whole pipeline, end to end: the generated `UserModel` base, the runtime
// schema `prisma generate` emitted, the compiler, Bun's SQL client and the
// shaper — against the template's own SQLite database.
//
// The database is copied to a temp file first. The test seeds a row it controls
// rather than depending on whatever `prisma/dev.db` happens to hold, and never
// writes to the committed file.
const SEEDED = {
  publicId: "gemi-orm-iteration-1-fixture",
  name: "Ada Lovelace",
  email: "ada@example.dev",
  // Distinct from anything already in the committed dev.db, so filtering on it
  // isolates this row.
  createdAt: 1600000000123,
};

let workspace: string;
let database: DatabaseManager;
let previous: Application | undefined;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "gemi-orm-"));
  const path = join(workspace, "dev.db");
  copyFileSync(join(import.meta.dirname, "../../prisma/dev.db"), path);

  previous = Application.getInstance();
  const app = new Application();
  database = new DatabaseManager({ url: `sqlite://${path}` });
  app.instance(DatabaseManager, database);
  // `Model.$exec` resolves the connection through the container on every call,
  // which is exactly what makes it swappable here.
  Application.setInstance(app);

  await database.sql.unsafe(
    `INSERT INTO "User"
       ("publicId", "name", "email", "globalRole", "createdAt", "updatedAt", "deletedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      SEEDED.publicId,
      SEEDED.name,
      SEEDED.email,
      2,
      SEEDED.createdAt,
      SEEDED.createdAt,
      null,
    ],
  );
});

afterAll(async () => {
  await database.close();
  Application.setInstance(previous);
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => clearPlanCache());

describe("User.findMany()", () => {
  test("reads the seeded row through the full pipeline", async () => {
    const users = await User.findMany({ where: { email: SEEDED.email } });

    expect(users).toHaveLength(1);
    const [user] = users;

    expect(user.email).toBe(SEEDED.email);
    expect(user.name).toBe(SEEDED.name);
    expect(user.publicId).toBe(SEEDED.publicId);
    expect(user.globalRole).toBe(2);
  });

  // SQLite has no DateTime and no Boolean storage class: Prisma stores a
  // DateTime as integer milliseconds. Handing the driver's raw value back would
  // already diverge from Prisma's result shape on the very first `createdAt`.
  test("decodes SQLite integers back into the values Prisma returns", async () => {
    const [user] = await User.findMany({ where: { email: SEEDED.email } });

    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.createdAt.getTime()).toBe(SEEDED.createdAt);
    expect(user.deletedAt).toBe(null);
  });

  // The mirror of the decoding above. Bun's SQLite driver binds a `Date` to
  // NULL, so without the dialect's encoder this returns an empty array — a
  // wrong answer rather than an error.
  test("accepts a Date as a filter value", async () => {
    const users = await User.findMany({
      where: { createdAt: new Date(SEEDED.createdAt) },
    });

    expect(users).toHaveLength(1);
    expect(users[0].email).toBe(SEEDED.email);
  });

  test("returns every scalar field", async () => {
    const [user] = await User.findMany({ where: { email: SEEDED.email } });

    expect(Object.keys(user)).toEqual([
      "id",
      "publicId",
      "name",
      "email",
      "emailVerifiedAt",
      "verificationToken",
      "locale",
      "globalRole",
      "password",
      "organizationId",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]);
  });

  test("returns an empty array when nothing matches", async () => {
    expect(await User.findMany({ where: { email: "nobody@example.dev" } }))
      .toEqual([]);
  });

  test("returns plain objects, not model instances", async () => {
    const [user] = await User.findMany({ where: { email: SEEDED.email } });
    expect(user).not.toBeInstanceOf(User);
    expect(Object.getPrototypeOf(user)).toBe(Object.prototype);
  });

  // Same shape, different value: compiled once, executed twice, two different
  // parameter arrays.
  test("compiles once across calls with the same shape", async () => {
    await User.findMany({ where: { email: SEEDED.email } });
    await User.findMany({ where: { email: "nobody@example.dev" } });

    expect(planCacheStats()).toMatchObject({ compiles: 1, hits: 1 });
  });

  // Signatures accept the full Prisma argument type from iteration 1; anything
  // not implemented yet has to say so rather than silently returning the wrong
  // rows.
  test("throws on an argument that is not implemented yet", async () => {
    await expect(User.findMany({ orderBy: { id: "asc" } })).rejects.toThrow(
      UnsupportedQueryError,
    );
    await expect(User.findMany({ orderBy: { id: "asc" } })).rejects.toThrow(
      "gemi ORM does not support 'orderBy' yet (User.findMany).",
    );
  });

  test("throws on take rather than returning the whole table", async () => {
    await expect(User.findMany({ take: 1 })).rejects.toThrow(
      "gemi ORM does not support 'take' yet (User.findMany).",
    );
  });
});
