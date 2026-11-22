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
import { authConfigDefaults } from "./config";
import { clearConsumedOAuthStates } from "./oauth/oauthState";
import { UserProvider } from "./UserProvider";

/**
 * #1361 against real databases: two sign-ups at once for the same new person,
 * through an OAuth provider (two tabs, each with its own state) or with a
 * password (a double submit). SQLite always; Postgres when
 * `TEST_POSTGRES_URL` is set.
 *
 * - OAuth: both sign in to one user, created once. The losing callback's
 *   insert fails on the unique email and the callback resolves the identity
 *   the winner committed.
 * - Password: one account; the other request is told the address exists,
 *   not answered 500.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const users = `gemi_signup_users_${suffix}`;
const accounts = `gemi_signup_social_${suffix}`;

const field = (name: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  column: name,
  type: "String",
  nullable: true,
  isId: false,
  isUpdatedAt: false,
  ...extra,
});
const id = () => field("id", { type: "Int", isId: true, nullable: false, default: { kind: "autoincrement" } as never });

const userSchema: ModelSchema = {
  name: "User",
  table: users,
  fields: {
    id: id(),
    email: field("email"),
    name: field("name"),
    password: field("password"),
    verificationToken: field("verificationToken"),
    emailVerifiedAt: field("emailVerifiedAt", { type: "DateTime" }),
    locale: field("locale"),
  },
  primaryKey: ["id"],
  uniques: [["email"]],
  relations: {
    socialAccount: {
      name: "socialAccount",
      model: "SocialAccount",
      kind: "many",
      relationName: "SocialAccountToUser",
      from: [],
      to: [],
      nullable: false,
    },
  },
};
const accountSchema: ModelSchema = {
  name: "SocialAccount",
  table: accounts,
  fields: {
    id: id(),
    userId: field("userId", { type: "Int", nullable: false }),
    provider: field("provider", { nullable: false }),
    providerId: field("providerId"),
    email: field("email"),
    username: field("username"),
    accessToken: field("accessToken"),
    refreshToken: field("refreshToken"),
    expiresAt: field("expiresAt", { type: "DateTime" }),
  },
  primaryKey: ["id"],
  uniques: [["provider", "providerId"]],
  relations: {
    user: {
      name: "user",
      model: "User",
      kind: "one",
      relationName: "SocialAccountToUser",
      from: ["userId"],
      to: ["id"],
      nullable: false,
    },
  },
};

/** What a generated model class adds: the operations, each a call to `$exec`. */
function modelOf(schema: ModelSchema) {
  return class extends Model {
    static $schema = schema;
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
    static update(args: object) {
      return this.$exec("update", args);
    }
    static updateMany(args: object) {
      return this.$exec("updateMany", args);
    }
  };
}
const User = modelOf(userSchema);
const SocialAccount = modelOf(accountSchema);

const dir = mkdtempSync(join(tmpdir(), "gemi-signup-race-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const backends = [
  {
    name: "sqlite",
    url: () => `sqlite://${join(dir, "db.sqlite")}`,
    ddl: [
      `CREATE TABLE "${users}" (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT, password TEXT, "verificationToken" TEXT, "emailVerifiedAt" DATETIME, locale TEXT)`,
      `CREATE TABLE "${accounts}" (id INTEGER PRIMARY KEY AUTOINCREMENT, "userId" INTEGER NOT NULL REFERENCES "${users}"(id), provider TEXT NOT NULL, "providerId" TEXT, email TEXT, username TEXT, "accessToken" TEXT, "refreshToken" TEXT, "expiresAt" DATETIME, UNIQUE (provider, "providerId"))`,
    ],
  },
  ...(POSTGRES_URL
    ? [
        {
          name: "postgres",
          url: () => POSTGRES_URL,
          ddl: [
            `CREATE TABLE "${users}" (id SERIAL PRIMARY KEY, email TEXT UNIQUE, name TEXT, password TEXT, "verificationToken" TEXT, "emailVerifiedAt" TIMESTAMPTZ, locale TEXT)`,
            `CREATE TABLE "${accounts}" (id SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL REFERENCES "${users}"(id), provider TEXT NOT NULL, "providerId" TEXT, email TEXT, username TEXT, "accessToken" TEXT, "refreshToken" TEXT, "expiresAt" TIMESTAMPTZ, UNIQUE (provider, "providerId"))`,
          ],
        },
      ]
    : []),
];

describe.each(backends)("two sign-ups at once for a new person ($name)", ({ url, ddl }) => {
  let database: DatabaseManager;
  let previous: Application | undefined;
  const created = vi.fn();
  let profile: Record<string, unknown> = {};
  const scripted = {
    getRedirectUrl: async (_req: unknown, ctx: { state: string }) =>
      `https://provider.example/authorize?state=${encodeURIComponent(ctx.state)}`,
    onCallback: async () => profile,
  };

  beforeAll(async () => {
    process.env.SECRET ??= "signup-race-test-secret";
    database = new DatabaseManager({ url: url() });
    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    const auth = new AuthManager(
      {
        ...authConfigDefaults({ passwordLimits: { signUp: { perIp: false } } }),
        oauthProviders: { scripted },
        verifyEmail: false,
        // Cheap, so the two requests overlap rather than queue on the hash.
        hashPassword: async (password: string) => `hashed:${password}`,
        onUserCreated: created,
      } as never,
      new UserProvider({ User, SocialAccount } as never),
    );
    auth.createOrUpdateSessionV2 = (async () => ({
      token: "session-token",
      expiresAt: new Date(Date.now() + 60_000),
    })) as never;
    application.instance(AuthManager, auth as never);
    application.instance(Translator, { detectLocale: () => "en-US" } as never);
    Application.setInstance(application);
    register("User", User);
    register("SocialAccount", SocialAccount);
    for (const statement of ddl) await database.connection().sql.unsafe(statement);
  });

  afterAll(async () => {
    await database.connection().sql.unsafe(`DROP TABLE IF EXISTS "${accounts}"`);
    await database.connection().sql.unsafe(`DROP TABLE IF EXISTS "${users}"`);
    clearRegistry();
    await database.close();
    if (previous) Application.setInstance(previous);
  });

  beforeEach(() => {
    created.mockReset();
    clearConsumedOAuthStates();
  });

  const rows = async (email: string) =>
    (await database.connection().sql.unsafe(`SELECT id FROM "${users}" WHERE email = '${email}'`)) as unknown[];

  function inRequest(target: string, init: RequestInit, params: Record<string, string>, fn: () => Promise<unknown>) {
    const req = new HttpRequest(new Request(target, init), params, "view");
    return RequestContext.run(req, async () => {
      const result = await fn();
      return { result, cookies: [...RequestContext.getStore().cookies] };
    });
  }

  /** `oauthRedirect` then `oauthCallback`'s request, as one browser tab makes them. */
  async function tab() {
    const { result, cookies } = await inRequest("http://localhost/auth/oauth/scripted", {}, { provider: "scripted" }, () =>
      new AuthController().oauthRedirect(),
    );
    const state = new URL((result as { destination: string }).destination).searchParams.get("state")!;
    const line = cookies.find((c) => c.startsWith("gemi_oauth="))!;
    const cookie = line.split(";")[0]!;
    return () =>
      inRequest(
        `http://localhost/auth/oauth/scripted/callback?code=c&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookie } },
        { provider: "scripted" },
        () => new AuthController().oauthCallback(),
      );
  }

  test("OAuth: both tabs sign in to one user, created once", async () => {
    for (let round = 0; round < 5; round++) {
      const email = `oauth-${round}-${crypto.randomUUID()}@example.test`;
      profile = { providerId: `p-${email}`, email, emailVerified: true, name: "Ada" };
      created.mockClear();
      const [a, b] = [await tab(), await tab()];
      const answers = await Promise.allSettled([a(), b()]);
      const failures = answers.filter((answer) => answer.status === "rejected") as PromiseRejectedResult[];
      expect(failures.map((failure) => String(failure.reason))).toEqual([]);
      for (const answer of answers) {
        const { result } = (answer as PromiseFulfilledResult<{ result: { session: unknown; error?: string } }>).value;
        expect(result.error).toBeUndefined();
        expect(result.session).toBeTruthy();
      }
      expect(await rows(email)).toHaveLength(1);
      expect(created).toHaveBeenCalledTimes(1);
    }
  });

  test("password: one account, and the other request is told the address exists", async () => {
    for (let round = 0; round < 5; round++) {
      const email = `password-${round}-${crypto.randomUUID()}@example.test`;
      created.mockClear();
      const signUp = () =>
        inRequest(
          "http://localhost/api/auth/sign-up",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: "correct horse battery", name: "Ada" }),
          },
          {},
          () => new AuthController().signUp(),
        );
      const answers = await Promise.allSettled([signUp(), signUp()]);
      const won = answers.filter((answer) => answer.status === "fulfilled");
      const lost = answers.filter((answer) => answer.status === "rejected") as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost.map((answer) => JSON.stringify(answer.reason?.errors ?? String(answer.reason)))).toEqual([
        JSON.stringify({ email: ["Email address already exists"] }),
      ]);
      expect(await rows(email)).toHaveLength(1);
      expect(created).toHaveBeenCalledTimes(1);
    }
  });

  test("password: an onUserCreated that throws still fails, and leaves no user", async () => {
    const email = `hook-${crypto.randomUUID()}@example.test`;
    created.mockImplementation(async () => {
      throw new Error("provisioning failed");
    });
    await expect(
      inRequest(
        "http://localhost/api/auth/sign-up",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "correct horse battery", name: "Ada" }),
        },
        {},
        () => new AuthController().signUp(),
      ),
    ).rejects.toThrow("provisioning failed");
    expect(await rows(email)).toHaveLength(0);
  });
});

describe("two sign-ups on the servers this run has no URL for", () => {
  // Named so that `-t "postgres"` (a CI step) cannot pass on this alone.
  test.skipIf(!!POSTGRES_URL)("the PG half did NOT run: set TEST_POSTGRES_URL", () => {
    console.warn("sign-up race: the PG half did NOT run: set TEST_POSTGRES_URL");
  });
});
