import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { DatabaseManager } from "../database/DatabaseManager";
import { Application } from "../foundation/Application";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { Translator } from "../i18n/Translator";
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

function backend(name: string, url: () => string, ddl: string) {
  return { name, url, ddl };
}

const dir = mkdtempSync(join(tmpdir(), "gemi-email-race-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const backends = [
  backend(
    "sqlite",
    () => `sqlite://${join(dir, "db.sqlite")}`,
    `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT, "emailVerifiedAt" DATETIME, locale TEXT)`,
  ),
  ...(POSTGRES_URL
    ? [
        backend(
          "postgres",
          () => POSTGRES_URL,
          `CREATE TABLE "${table}" (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, "emailVerifiedAt" TIMESTAMPTZ, locale TEXT)`,
        ),
      ]
    : []),
];

describe.each(backends)("two email-code verifies at once for a new address ($name)", ({ url, ddl }) => {
  let database: DatabaseManager;
  let previous: Application | undefined;
  let created: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    database = new DatabaseManager({ url: url() });
    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    created = vi.fn();
    const auth = new AuthManager(
      { emailCode: { enabled: true, createUser: true }, onUserCreated: created } as never,
      new UserProvider({ User } as never),
    );
    auth.createOrUpdateSessionV2 = (async () => ({
      token: "session-token",
      expiresAt: new Date(Date.now() + 60_000),
    })) as never;
    application.instance(AuthManager, auth as never);
    application.instance(Translator, { detectLocale: () => "en-US" } as never);
    Application.setInstance(application);
    register("User", User);
    await database.connection().sql.unsafe(ddl);
  });

  afterAll(async () => {
    await database.connection().sql.unsafe(`DROP TABLE IF EXISTS "${table}"`);
    clearRegistry();
    await database.close();
    if (previous) Application.setInstance(previous);
  });

  beforeEach(() => {
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    process.env.SECRET ??= "race-test-secret";
    created.mockClear();
  });

  const verify = (email: string) => {
    const req = new HttpRequest(
      new Request("https://app.example/api/auth/email-code/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: "000000" }),
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
});

describe("two email-code verifies on the servers this run has no URL for", () => {
  test.skipIf(!!POSTGRES_URL)("postgres did NOT run: set TEST_POSTGRES_URL", () => {
    console.warn("email-code race: postgres did NOT run: set TEST_POSTGRES_URL");
  });
});
