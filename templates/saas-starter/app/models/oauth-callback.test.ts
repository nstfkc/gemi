import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { HttpRequest } from "gemi/http";
import { Translator, translationConfigDefaults } from "gemi/i18n";
import { UserProvider } from "gemi/kernel";
import { clearPlanCache } from "gemi/orm";
import { AuthManager, GoogleOAuthProvider } from "gemi/services";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// Neither is a public export — the controller is reached through the route
// table, and the request scope is the server's. This suite exercises the
// callback itself, so it reaches them by path through the linked package.
import { AuthController } from "../../node_modules/gemi/auth/AuthController";
import { OAuthProvider } from "../../node_modules/gemi/auth/oauth/OAuthProvider";
import { RequestContext } from "../../node_modules/gemi/http/requestContext";

import { POSTGRES_URL, applyMigrations } from "./scratch";
import {
  AccountModel,
  MagicLinkTokenModel,
  OrganizationInvitationModel,
  PasswordResetTokenModel,
  SessionModel,
  SocialAccountModel,
  UserModel,
} from "./generated";

/**
 * `AuthController.oauthCallback` against a real database, through the real
 * `GoogleOAuthProvider` with Google's two endpoints faked at `fetch` — #546.
 *
 * The contract under test: a provider account is identified by
 * `(provider, providerId)`, Google's `sub` being the `providerId`. A returning
 * account resolves by that before email, so a changed email or display name
 * never moves it to a different user; email is the fallback for an account not
 * yet linked, and a legacy row (written with `providerId: ""` before the
 * callback recorded one) is claimed by the user it already belongs to.
 */

/** What Google's userinfo endpoint answers for the next callback. */
let userinfo: Record<string, unknown> = {};

function fakeGoogle() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.host === "oauth2.googleapis.com") {
        return Response.json({ access_token: "google-access-token" });
      }
      if (url.host === "www.googleapis.com") {
        return Response.json(userinfo);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

/** A provider that returns whatever the test says, for the non-Google paths. */
class ScriptedProvider extends OAuthProvider {
  next: Awaited<ReturnType<OAuthProvider["onCallback"]>> = {};
  getRedirectUrl() {
    return "https://provider.test/authorize";
  }
  async onCallback() {
    return this.next;
  }
}

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;
    const scripted = new ScriptedProvider();
    const hooks: string[] = [];
    let failOnUserCreated = false;

    const TABLES = [
      "SocialAccount",
      "Session",
      "PasswordResetToken",
      "MagicLinkToken",
      "Account",
      "User",
      "OrganizationInvitation",
      "Organization",
    ];

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-oauth-callback-"));
        const path = join(workspace, "oauth.db");
        await applyMigrations(path);
        target = `sqlite://${path}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      application.instance(
        Translator,
        new Translator({
          ...translationConfigDefaults(),
          supportedLocales: ["en-US"],
          detectLocale: () => "en-US",
        }) as never,
      );
      application.instance(
        AuthManager,
        new AuthManager(
          {
            oauthProviders: {
              google: new GoogleOAuthProvider({
                clientId: "id",
                clientSecret: "secret",
              }),
              scripted,
            },
            onUserCreated: async (user: any) => {
              hooks.push(`created:${user.email}`);
              if (failOnUserCreated) throw new Error("provisioning failed");
            },
            onSignUp: async (user: any) => {
              hooks.push(`signup:${user.email}`);
            },
            onSignIn: async (user: any) => {
              hooks.push(`signin:${user.email}`);
            },
          },
          new UserProvider({
            User: UserModel,
            Session: SessionModel,
            Account: AccountModel,
            PasswordResetToken: PasswordResetTokenModel,
            MagicLinkToken: MagicLinkTokenModel,
            OrganizationInvitation: OrganizationInvitationModel,
            SocialAccount: SocialAccountModel,
          }),
        ) as never,
      );
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      fakeGoogle();
      hooks.length = 0;
      failOnUserCreated = false;
      scripted.next = {};
      if (url) {
        await raw.unsafe(
          `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
        );
      } else {
        for (const table of TABLES) await raw.unsafe(`DELETE FROM "${table}"`);
      }
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /**
     * One callback, as the router runs it: inside a request scope, with the
     * provider name as the route parameter. The session token is a hash of
     * email and user agent, so concurrent callbacks for one user are given
     * different agents — two identical ones would collide on `Session.token`,
     * which is the session path's concern and not this suite's.
     */
    async function callback(provider = "google", agent = "test-agent") {
      const req = new HttpRequest(
        new Request(`http://localhost/auth/oauth/${provider}/callback?code=c`, {
          headers: { "User-Agent": agent },
        }),
        { provider },
        "view",
      );
      return await RequestContext.run(req as never, () =>
        new AuthController().oauthCallback(req as never),
      );
    }

    async function users() {
      const rows: any = await raw.unsafe(`SELECT "id", "email", "name" FROM "User" ORDER BY "id"`);
      return [...rows];
    }

    async function socialAccounts() {
      const rows: any = await raw.unsafe(
        `SELECT "userId", "provider", "providerId", "username", "email" FROM "SocialAccount" ORDER BY "id"`,
      );
      return [...rows];
    }

    async function seedUser(email: string) {
      const rows: any = await raw.unsafe(
        `INSERT INTO "User" ("publicId", "email", "name", "locale", "updatedAt") VALUES ($1, $2, $3, 'en-US', CURRENT_TIMESTAMP) RETURNING "id"`,
        [`pub-${email}`, email, email.split("@")[0]],
      );
      return rows[0].id as number;
    }

    async function seedSocialAccount(userId: number, provider: string, providerId: string | null) {
      await raw.unsafe(
        `INSERT INTO "SocialAccount" ("userId", "provider", "providerId", "accessToken", "refreshToken", "expiresAt", "updatedAt") VALUES ($1, $2, $3, '', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, provider, providerId],
      );
    }

    // --- the provider ------------------------------------------------------

    test("GoogleOAuthProvider returns sub as providerId", async () => {
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };
      const google = new GoogleOAuthProvider({ clientId: "id" });
      const req = new HttpRequest(
        new Request("http://localhost/auth/oauth/google/callback?code=c"),
        { provider: "google" },
        "view",
      );

      expect(await google.onCallback(req as never)).toEqual({
        providerId: "g-1",
        name: "Ada",
        email: "ada@x.test",
      });
    });

    test("GoogleOAuthProvider returns nothing for a response without sub", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const google = new GoogleOAuthProvider({ clientId: "id" });
      const req = new HttpRequest(
        new Request("http://localhost/auth/oauth/google/callback?code=c"),
        { provider: "google" },
        "view",
      );

      for (const body of [
        { email: "ada@x.test", name: "Ada" },
        { sub: "", email: "ada@x.test" },
        { error: "invalid_token" },
      ]) {
        userinfo = body;
        expect(await google.onCallback(req as never)).toEqual({});
      }
      error.mockRestore();
    });

    // --- first sign-in and return ------------------------------------------

    test("a first sign-in persists the subject, not an empty placeholder", async () => {
      userinfo = { sub: "g-1", name: "Ada Lovelace", email: "ada@x.test" };

      const { session } = await callback();

      expect(session).not.toBeNull();
      const [user] = await users();
      expect(user.email).toBe("ada@x.test");
      expect(await socialAccounts()).toEqual([
        {
          userId: user.id,
          provider: "google",
          providerId: "g-1",
          // Google has no handle, and the display name is not one.
          username: null,
          email: "ada@x.test",
        },
      ]);
      expect(hooks).toEqual(["created:ada@x.test", "signup:ada@x.test"]);
    });

    test("two subjects with the same display name stay two accounts", async () => {
      userinfo = { sub: "g-1", name: "Sam Smith", email: "sam1@x.test" };
      await callback();
      userinfo = { sub: "g-2", name: "Sam Smith", email: "sam2@x.test" };
      await callback();

      const [first, second] = await users();
      expect(await socialAccounts()).toMatchObject([
        { userId: first.id, providerId: "g-1" },
        { userId: second.id, providerId: "g-2" },
      ]);
    });

    test("a returning subject with a changed email and name is the same user", async () => {
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };
      await callback();
      const [before] = await users();
      hooks.length = 0;

      userinfo = { sub: "g-1", name: "Ada King", email: "ada.king@x.test" };
      const { session } = await callback();

      expect(session!.user.id).toBe(before.id);
      // The local account is not rewritten from the provider's profile.
      expect(await users()).toEqual([before]);
      expect(await socialAccounts()).toHaveLength(1);
      expect(hooks).toEqual(["signin:ada@x.test"]);
    });

    test("a returning subject whose new email is another user's stays with its own user", async () => {
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };
      await callback();
      const [ada] = await users();
      const otherId = await seedUser("grace@x.test");

      userinfo = { sub: "g-1", name: "Ada", email: "grace@x.test" };
      const { session } = await callback();

      expect(session!.user.id).toBe(ada.id);
      expect(session!.user.id).not.toBe(otherId);
      expect(await socialAccounts()).toMatchObject([{ userId: ada.id, providerId: "g-1" }]);
    });

    test("repeating a callback creates nothing new", async () => {
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };
      await callback();
      await callback();
      await callback();

      expect(await users()).toHaveLength(1);
      expect(await socialAccounts()).toHaveLength(1);
    });

    // --- linking by email --------------------------------------------------

    test("an existing email user is signed in and linked", async () => {
      const id = await seedUser("ada@x.test");
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };

      const { session } = await callback();

      expect(session!.user.id).toBe(id);
      expect(await socialAccounts()).toMatchObject([{ userId: id, providerId: "g-1" }]);
      expect(hooks).toEqual(["signin:ada@x.test"]);

      // And from now on it resolves by subject, whatever the email says.
      userinfo = { sub: "g-1", name: "Ada", email: "new@x.test" };
      expect((await callback()).session!.user.id).toBe(id);
    });

    test.each([
      ["an empty string", ""],
      ["NULL", null],
    ])("a legacy row holding %s is claimed, not duplicated", async (_, legacy) => {
      const id = await seedUser("ada@x.test");
      await seedSocialAccount(id, "google", legacy);
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };

      const { session } = await callback();

      expect(session!.user.id).toBe(id);
      expect(await socialAccounts()).toMatchObject([{ userId: id, providerId: "g-1" }]);
    });

    test("an email already linked to a different subject is refused", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };
      await callback();
      const before = await socialAccounts();
      hooks.length = 0;

      userinfo = { sub: "g-2", name: "Ada", email: "ada@x.test" };
      const { session } = await callback();

      expect(session).toBeNull();
      expect(await socialAccounts()).toEqual(before);
      expect(await users()).toHaveLength(1);
      expect(hooks).toEqual([]);
      const sessions: any = await raw.unsafe(`SELECT COUNT(*) AS n FROM "Session"`);
      expect(Number([...sessions][0].n)).toBe(1);
      error.mockRestore();
    });

    // --- missing identity --------------------------------------------------

    test("a Google response without sub is refused and writes nothing", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await seedUser("ada@x.test");
      userinfo = { name: "Ada", email: "ada@x.test" };

      const { session } = await callback();

      expect(session).toBeNull();
      expect(await socialAccounts()).toEqual([]);
      expect(hooks).toEqual([]);
      error.mockRestore();
    });

    test("an unknown subject with no email is refused", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      userinfo = { sub: "g-1", name: "Ada" };

      const { session } = await callback();

      expect(session).toBeNull();
      expect(await users()).toEqual([]);
      error.mockRestore();
    });

    test("a known subject signs in even without an email", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };
      await callback();
      const [ada] = await users();

      userinfo = { sub: "g-1", name: "Ada" };
      expect((await callback()).session!.user.id).toBe(ada.id);
      error.mockRestore();
    });

    // --- other providers ---------------------------------------------------

    test("a provider with no providerId keeps email-only behaviour and writes no row", async () => {
      scripted.next = { email: "ada@x.test", name: "Ada" };

      const first = await callback("scripted");
      const second = await callback("scripted");

      expect(first.session!.user.id).toBe(second.session!.user.id);
      expect(await users()).toHaveLength(1);
      expect(await socialAccounts()).toEqual([]);
      expect(hooks).toEqual(["created:ada@x.test", "signup:ada@x.test", "signin:ada@x.test"]);
    });

    test("a provider with a handle keeps it as the username", async () => {
      scripted.next = {
        email: "ada@x.test",
        name: "Ada",
        username: "ada",
        providerId: "x-1",
      };

      await callback("scripted");

      expect(await socialAccounts()).toMatchObject([
        { provider: "scripted", providerId: "x-1", username: "ada" },
      ]);
    });

    test("the same providerId at two providers is two identities", async () => {
      userinfo = { sub: "1", name: "Ada", email: "ada@x.test" };
      await callback();
      scripted.next = { email: "grace@x.test", name: "Grace", providerId: "1" };
      await callback("scripted");

      const [ada, grace] = await users();
      expect(await socialAccounts()).toMatchObject([
        { userId: ada.id, provider: "google", providerId: "1" },
        { userId: grace.id, provider: "scripted", providerId: "1" },
      ]);
    });

    // --- failure and concurrency -------------------------------------------

    test("a failed onUserCreated rolls back the user and the link, and propagates", async () => {
      failOnUserCreated = true;
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };

      await expect(callback()).rejects.toThrow("provisioning failed");

      expect(await users()).toEqual([]);
      expect(await socialAccounts()).toEqual([]);
      expect(hooks).toEqual(["created:ada@x.test"]);
    });

    // Postgres only. On SQLite the whole database is one connection, and a
    // second sign-up transaction opened while the first is still running fails
    // with "cannot start a transaction within a transaction" — so do two
    // concurrent email/password sign-ups. That is the driver, before any of
    // the identity logic runs; the linking case below takes no transaction
    // and runs on both.
    test.skipIf(!url)(
      "concurrent first sign-ins for one subject converge on one user",
      async () => {
        userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };

        const results = await Promise.all([
          callback("google", "agent-1"),
          callback("google", "agent-2"),
          callback("google", "agent-3"),
        ]);

        const ids = new Set(results.map((result) => result.session!.user.id));
        expect(ids.size).toBe(1);
        expect(await users()).toHaveLength(1);
        expect(await socialAccounts()).toHaveLength(1);
        expect(hooks.filter((hook) => hook.startsWith("created"))).toHaveLength(1);
      },
    );

    test("concurrent first links for one existing user converge on one row", async () => {
      const id = await seedUser("ada@x.test");
      userinfo = { sub: "g-1", name: "Ada", email: "ada@x.test" };

      const results = await Promise.all([
        callback("google", "agent-1"),
        callback("google", "agent-2"),
        callback("google", "agent-3"),
      ]);

      for (const result of results) expect(result.session!.user.id).toBe(id);
      expect(await socialAccounts()).toHaveLength(1);
    });

    // --- the constraint ----------------------------------------------------

    test("the schema holds one owner per provider identity, and any number of legacy rows", async () => {
      const a = await seedUser("a@x.test");
      const b = await seedUser("b@x.test");

      await seedSocialAccount(a, "google", null);
      await seedSocialAccount(b, "google", null);
      await seedSocialAccount(a, "google", "g-1");
      await expect(seedSocialAccount(b, "google", "g-1")).rejects.toThrow();
    });
  });
}

suite("oauth callback (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("oauth callback (postgres)", POSTGRES_URL);
} else {
  describe.skip("oauth callback (postgres) — set TEST_POSTGRES_URL to run", () => {
    test("skipped", () => {});
  });
}
