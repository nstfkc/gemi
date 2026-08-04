import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  RecordNotFoundError,
  UnsupportedQueryError,
  clearPlanCache,
  planCacheStats,
} from "gemi/orm";
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
      "metadata",
      "avatar",
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

  // `cursor` is refused twice over, and both refusals are worth keeping.
  //
  // It is now a **compile error**, which it was not while the signatures took
  // Prisma's argument types verbatim: `Prisma.UserFindManyArgs` admits `cursor`
  // and `distinct`, because Prisma's engine implements them, and gemi refuses
  // both permanently and by design. So the old types type-checked code that
  // threw — the `@ts-expect-error` directives below are the improvement, and
  // they fail loudly if the argument is ever quietly re-admitted.
  //
  // The **runtime** refusal still has to exist and still has to be exact. Types
  // are erased, so a plain-JavaScript caller, a `JSON.parse`d filter or an `any`
  // reaches the compiler with the argument intact; it must say so rather than
  // silently return the wrong rows, and say *which kind* of refusal it is, since
  // "wait for a release" and "change the code" are different answers.
  test("throws on an argument refused by design, and says it is a decision", async () => {
    // @ts-expect-error `cursor` is not in gemi's argument grammar — by design.
    await expect(User.findMany({ cursor: { id: 1 } })).rejects.toThrow(
      UnsupportedQueryError,
    );
    // @ts-expect-error as above; the runtime message is what is under test.
    await expect(User.findMany({ cursor: { id: 1 } })).rejects.toThrow(
      "gemi ORM does not implement 'cursor' (User.findMany), and this is a " +
        "decision rather than a gap.",
    );
    // ...and it names what to reach for instead.
    // @ts-expect-error as above.
    await expect(User.findMany({ cursor: { id: 1 } })).rejects.toThrow(
      /DB\.query/,
    );
  });

  /** The other half of the same decision: `omit` runs now. */
  test("omit drops a column from the payload without a select", async () => {
    const [user]: any = await User.findMany({
      where: { email: SEEDED.email },
      omit: { password: true },
    });

    expect("password" in user).toBe(false);
    // Everything else is still there, which is the difference from `select`:
    // a column added to the model later is included rather than forgotten.
    expect(user.email).toBe(SEEDED.email);
    expect("locale" in user).toBe(true);
  });

  // The relation is loaded through the *generated* artifact's topology: this
  // model class was never told where `accounts` lives, only that it is a
  // relation named `AccountToUser` on a model named `Account`.
  test("include loads the relation, and an empty one is an array", async () => {
    const [user] = await User.findMany({
      where: { email: SEEDED.email },
      include: { accounts: true },
    });

    expect(user.accounts).toEqual([]);
    expect("accounts" in user).toBe(true);
  });
});

describe("the single-row reads", () => {
  test("findUnique returns the row or null", async () => {
    const found = await User.findUnique({ where: { email: SEEDED.email } });
    expect(found?.publicId).toBe(SEEDED.publicId);

    expect(await User.findUnique({ where: { email: "nobody@example.dev" } }))
      .toBe(null);
  });

  // Anything else would be a query that silently returns the first of several
  // matches.
  test("findUnique refuses a non-unique field, naming what it accepts", async () => {
    await expect(User.findUnique({ where: { name: "Ada" } } as never)).rejects
      .toThrow(/declares: id, publicId, email/);
  });

  test("findUniqueOrThrow raises RecordNotFoundError when nothing matches", async () => {
    await expect(
      User.findUniqueOrThrow({ where: { email: "nobody@example.dev" } }),
    ).rejects.toThrow(RecordNotFoundError);

    const found = await User.findUniqueOrThrow({
      where: { email: SEEDED.email },
    });
    expect(found.publicId).toBe(SEEDED.publicId);
  });

  test("findFirst applies orderBy", async () => {
    const newest = await User.findFirst({ orderBy: { createdAt: "desc" } });
    const oldest = await User.findFirst({ orderBy: { createdAt: "asc" } });
    expect(newest?.id).not.toBe(oldest?.id);
  });

  test("count returns a number", async () => {
    const total = await User.count();
    expect(typeof total).toBe("number");
    expect(total).toBeGreaterThanOrEqual(1);

    expect(await User.count({ where: { email: SEEDED.email } })).toBe(1);
    expect(await User.count({ where: { email: "nobody@example.dev" } })).toBe(0);
  });
});
