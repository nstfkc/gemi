import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { DatabaseManager } from "../database/DatabaseManager";
import { Application } from "../foundation/Application";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { Translator } from "../i18n/Translator";
import { deferUntilCommit } from "../orm/context";
import { Model } from "../orm/Model";
import { clearRegistry, register } from "../orm/registry";
import type { FieldSchema, ModelSchema } from "../orm/schema";
import { AuthController } from "./AuthController";
import { AuthManager } from "./AuthManager";
import { UserProvider } from "./UserProvider";

/**
 * #1356 against real databases: two `/auth/email-code/verify` requests at
 * once for an address with no user create it once, and neither answers 500.
 * SQLite always; Postgres when `TEST_POSTGRES_URL` is set.
 *
 * Without `UserProvider.transaction` queueing on SQLite, the SQLite rounds
 * fail with "cannot start a transaction within a transaction"; without the
 * recovery, a 500 on the unique email, on both.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

const table = `gemi_race_users_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const field = (name: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  column: name,
  type: "String",
  nullable: true,
  isId: false,
  isUpdatedAt: false,
  ...extra,
});
const schema: ModelSchema = {
  name: "User",
  table,
  fields: {
    id: field("id", { type: "Int", isId: true, nullable: false, default: { kind: "autoincrement" } as never }),
    email: field("email", { nullable: false }),
    name: field("name"),
    emailVerifiedAt: field("emailVerifiedAt", { type: "DateTime" }),
    locale: field("locale"),
  },
  primaryKey: ["id"],
  uniques: [["email"]],
  relations: {},
};
/** What a generated model class adds: the operations, each a call to `$exec`. */
class User extends Model {
  static $schema = schema;
  static findUnique(args: object) {
    return this.$exec("findUnique", args);
  }
  static findFirst(args: object) {
    return this.$exec("findFirst", args);
  }
  static create(args: object) {
    return this.$exec("create", args);
  }
  static update(args: object) {
    return this.$exec("update", args);
  }
}

const tokenTable = `gemi_race_codes_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const tokenSchema: ModelSchema = {
  name: "MagicLinkToken",
  table: tokenTable,
  fields: {
    id: field("id", { type: "Int", isId: true, nullable: false, default: { kind: "autoincrement" } as never }),
    token: field("token", { nullable: false }),
    email: field("email", { nullable: false }),
    pin: field("pin", { nullable: false }),
    createdAt: field("createdAt", { type: "DateTime", nullable: false, default: { kind: "now" } as never }),
  },
  primaryKey: ["id"],
  uniques: [
    ["token", "email"],
    ["pin", "email"],
  ],
  relations: {},
};
class MagicLinkToken extends Model {
  static $schema = tokenSchema;
  static findUnique(args: object) {
    return this.$exec("findUnique", args);
  }
  static findFirst(args: object) {
    return this.$exec("findFirst", args);
  }
  static findMany(args: object) {
    return this.$exec("findMany", args);
  }
  static create(args: object) {
    return this.$exec("create", args);
  }
  static deleteMany(args: object) {
    return this.$exec("deleteMany", args);
  }
}

function backend(name: string, url: () => string, ddl: string[]) {
  return { name, url, ddl };
}

const dir = mkdtempSync(join(tmpdir(), "gemi-email-race-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const backends = [
  backend(
    "sqlite",
    () => `sqlite://${join(dir, "db.sqlite")}`,
    [
      `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT, "emailVerifiedAt" DATETIME, locale TEXT)`,
      `CREATE TABLE "${tokenTable}" (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, email TEXT NOT NULL, pin TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    ],
  ),
  ...(POSTGRES_URL
    ? [
        backend(
          "postgres",
          () => POSTGRES_URL,
          [
            `CREATE TABLE "${table}" (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, "emailVerifiedAt" TIMESTAMPTZ, locale TEXT)`,
            `CREATE TABLE "${tokenTable}" (id SERIAL PRIMARY KEY, token TEXT NOT NULL, email TEXT NOT NULL, pin TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`,
          ],
        ),
      ]
    : []),
];

describe.each(backends)("two email-code verifies at once for a new address ($name)", ({ url, ddl }) => {
  let database: DatabaseManager;
  let previous: Application | undefined;
  let created: ReturnType<typeof vi.fn>;
  let auth: AuthManager;
  let users: UserProvider;

  beforeAll(async () => {
    database = new DatabaseManager({ url: url() });
    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    created = vi.fn();
    users = new UserProvider({ User, MagicLinkToken } as never);
    auth = new AuthManager(
      {
        emailCode: {
          enabled: true,
          createUser: true,
          activeCodes: 1,
          expiresInMinutes: 10,
          linkExpiresInMinutes: 10,
          maxAttempts: 5,
        },
        generateMagicLinkToken: async () => crypto.randomUUID(),
        generateCode: async () => undefined,
        onUserCreated: created,
      } as never,
      users,
    );
    auth.createOrUpdateSessionV2 = (async () => ({
      token: "session-token",
      expiresAt: new Date(Date.now() + 60_000),
    })) as never;
    application.instance(AuthManager, auth as never);
    application.instance(Translator, { detectLocale: () => "en-US" } as never);
    Application.setInstance(application);
    register("User", User);
    register("MagicLinkToken", MagicLinkToken);
    for (const statement of ddl) await database.connection().sql.unsafe(statement);
  });

  afterAll(async () => {
    await database.connection().sql.unsafe(`DROP TABLE IF EXISTS "${table}"`);
    await database.connection().sql.unsafe(`DROP TABLE IF EXISTS "${tokenTable}"`);
    clearRegistry();
    await database.close();
    if (previous) Application.setInstance(previous);
  });

  beforeEach(() => {
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    process.env.SECRET ??= "race-test-secret";
    created.mockReset();
  });

  const verify = (email: string, code = "000000") => {
    const req = new HttpRequest(
      new Request("https://app.example/api/auth/email-code/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      }),
      {},
      "api",
    );
    return RequestContext.run(req, () => new AuthController().verifyEmailCode());
  };

  test("both sign in to one account, created once", async () => {
    for (let round = 0; round < 5; round++) {
      const email = `new-${round}-${crypto.randomUUID()}@example.test`;
      created.mockClear();
      const answers = await Promise.allSettled([verify(email), verify(email)]);
      const failures = answers.filter((answer) => answer.status === "rejected") as PromiseRejectedResult[];
      expect(failures.map((failure) => String(failure.reason))).toEqual([]);
      const values = answers.map((answer) => (answer as PromiseFulfilledResult<{ isNewUser: boolean }>).value);
      expect(values.map((value) => value.isNewUser).sort()).toEqual([false, true]);
      const rows = (await database
        .connection()
        .sql.unsafe(`SELECT id FROM "${table}" WHERE email = '${email}'`)) as unknown[];
      expect(rows).toHaveLength(1);
      expect(created).toHaveBeenCalledTimes(1);
    }
  });

  test("with an issued code: one signs in, the other is refused the spent code, no 500", async () => {
    const email = `issued-${crypto.randomUUID()}@example.test`;
    const { pin } = await auth.issueOneTimeCode(email, 6);
    const answers = await Promise.allSettled([verify(email, pin), verify(email, pin)]);
    const won = answers.filter((answer) => answer.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect((won[0] as PromiseFulfilledResult<{ isNewUser: boolean }>).value.isNewUser).toBe(true);
    for (const answer of answers) {
      if (answer.status === "rejected") expect(JSON.stringify(answer.reason.errors ?? String(answer.reason))).toContain("invalid_code");
    }
    const rows = (await database
      .connection()
      .sql.unsafe(`SELECT id FROM "${table}" WHERE email = '${email}'`)) as unknown[];
    expect(rows).toHaveLength(1);
    expect(created).toHaveBeenCalledTimes(1);
  });

  test(
    "a sign-up whose after-commit work opens another sign-up transaction does not hang",
    async () => {
      // An `onUserCreated` that dispatches an event, whose sync listener runs
      // after the commit and writes through the provider again.
      created.mockImplementation(async () => {
        deferUntilCommit(() => users.transaction(async () => {}));
      });
      const email = `listener-${crypto.randomUUID()}@example.test`;
      const answer = await verify(email);
      expect(answer.isNewUser).toBe(true);
      // And the queue is free for the next one.
      expect((await verify(`after-${crypto.randomUUID()}@example.test`)).isNewUser).toBe(true);
    },
    5_000,
  );
});

describe("two email-code verifies on the servers this run has no URL for", () => {
  // Named so that `-t "postgres"` (the CI step) cannot pass on this alone.
  test.skipIf(!!POSTGRES_URL)("the PG half did NOT run: set TEST_POSTGRES_URL", () => {
    console.warn("email-code race: the PG half did NOT run: set TEST_POSTGRES_URL");
  });
});
