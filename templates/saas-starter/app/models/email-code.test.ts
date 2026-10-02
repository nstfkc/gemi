import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { HttpRequest, ValidationError } from "gemi/http";
import { Translator, translationConfigDefaults } from "gemi/i18n";
import { UserProvider } from "gemi/kernel";
import { clearPlanCache } from "gemi/orm";
import { AuthManager, InMemoryRateLimiter, RateLimiter } from "gemi/services";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// Reached by path, as `oauth-callback.test.ts` does: the controller is served
// through the route table and the request scope is the server's.
import { AuthController } from "../../node_modules/gemi/auth/AuthController";
import { RequestContext } from "../../node_modules/gemi/http/requestContext";
import { RateLimitExceededError } from "../../node_modules/gemi/http/RateLimitMiddleware";

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
 * One-time email codes and the hardened magic-link PIN routes (#708), against a
 * real database: `/auth/email-code`, `/auth/email-code/verify`,
 * `/auth/magic-link`, `/auth/sign-in-with-pin(-v2)` and
 * `/auth/sign-in/magic-link`.
 */

type Sent = { email: string; code: string; token: string; isNewUser: boolean };

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;
    let application: Application;

    const sent: Sent[] = [];
    const created: string[] = [];
    const authenticated: Array<{
      email: string;
      isNewUser: boolean;
      method: string;
      header: string | null;
      hasPassword: boolean;
    }> = [];
    const magicLinks: Array<{ email: string; pin: string; token: string }> = [];
    let emailCode: Record<string, unknown> = {};
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

    function bindAuth() {
      application.instance(
        AuthManager,
        new AuthManager(
          {
            emailCode: {
              enabled: true,
              createUser: true,
              send: async (args) => {
                sent.push({
                  email: args.email,
                  code: args.code,
                  token: args.token,
                  isNewUser: args.isNewUser,
                });
              },
              ...emailCode,
            },
            onUserCreated: async (user: any) => {
              created.push(user.email);
              if (failOnUserCreated) throw new Error("provisioning failed");
            },
            onMagicLinkCreated: async (_user: any, args: any) => {
              magicLinks.push(args);
            },
            onAuthenticated: async ({ user, isNewUser, method, req }) => {
              authenticated.push({
                email: user.email!,
                isNewUser,
                method,
                header: req.headers.get("x-anon-owner"),
                hasPassword: "password" in user,
              });
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
    }

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-email-code-"));
        const path = join(workspace, "email-code.db");
        await applyMigrations(path);
        target = `sqlite://${path}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      previous = Application.getInstance();
      application = new Application();
      application.instance(DatabaseManager, database as never);
      application.instance(
        Translator,
        new Translator({
          ...translationConfigDefaults(),
          supportedLocales: ["en-US"],
          detectLocale: () => "en-US",
        }) as never,
      );
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      vi.stubEnv("SECRET", "test-secret");
      clearPlanCache();
      sent.length = 0;
      created.length = 0;
      authenticated.length = 0;
      magicLinks.length = 0;
      emailCode = {};
      failOnUserCreated = false;
      // A fresh limiter per case, bound the way RateLimiterServiceProvider binds it.
      application.instance(
        RateLimiter,
        new RateLimiter({ driver: new InMemoryRateLimiter(), limit: 1000, window: 60 }) as never,
      );
      bindAuth();
      if (url) {
        await raw.unsafe(
          `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
        );
      } else {
        for (const table of TABLES) await raw.unsafe(`DELETE FROM "${table}"`);
      }
    });

    type Action =
      | "requestEmailCode"
      | "verifyEmailCode"
      | "createMagicLinkToken"
      | "signInWithPin"
      | "signInWithPinV2";

    async function post(
      action: Action,
      body: Record<string, unknown>,
      options: { ip?: string; headers?: Record<string, string> } = {},
    ): Promise<any> {
      const req = new HttpRequest(
        new Request(`http://localhost/api/auth/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "test-agent",
            "x-forwarded-for": options.ip ?? "203.0.113.1",
            ...options.headers,
          },
          body: JSON.stringify(body),
        }),
        {},
        "api",
      );
      return await RequestContext.run(req as never, () =>
        (new AuthController() as any)[action](req as never),
      );
    }

    /** Resolves to the result, or to what was thrown. */
    async function attempt(...args: Parameters<typeof post>) {
      try {
        return { ok: true as const, result: await post(...args) };
      } catch (error) {
        return { ok: false as const, error };
      }
    }

    function errorsOf(outcome: Awaited<ReturnType<typeof attempt>>) {
      expect(outcome.ok).toBe(false);
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(ValidationError);
      return (error as ValidationError).errors;
    }

    async function users() {
      const rows: any = await raw.unsafe(`SELECT "id", "email" FROM "User" ORDER BY "id"`);
      return [...rows];
    }

    async function codeRows() {
      const rows: any = await raw.unsafe(
        `SELECT "id", "email", "pin", "token", "createdAt" FROM "MagicLinkToken" ORDER BY "id"`,
      );
      return [...rows];
    }

    async function seedUser(email: string) {
      const rows: any = await raw.unsafe(
        `INSERT INTO "User" ("publicId", "email", "name", "locale", "password", "updatedAt") VALUES ($1, $2, $3, 'en-US', 'secret-hash', CURRENT_TIMESTAMP) RETURNING "id"`,
        [`pub-${email}`, email, email.split("@")[0]],
      );
      return rows[0].id as number;
    }

    async function ageCodes(minutes: number) {
      const at = new Date(Date.now() - minutes * 60_000);
      await raw.unsafe(`UPDATE "MagicLinkToken" SET "createdAt" = $1`, [
        url ? at : at.getTime(),
      ]);
    }

    /** A code that is not `code`. */
    const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

    // --- /auth/email-code ----------------------------------------------------

    test("routes answer 404 unless enabled", async () => {
      emailCode = { enabled: false };
      bindAuth();
      const outcome = await attempt("requestEmailCode", { email: "a@x.test" });
      expect(outcome.ok).toBe(false);
      expect((outcome as any).error.payload.api.status).toBe(404);
      const verify = await attempt("verifyEmailCode", { email: "a@x.test", code: "123456" });
      expect((verify as any).error.payload.api.status).toBe(404);
    });

    test("known and unknown addresses get the same answer", async () => {
      await seedUser("known@x.test");

      expect(await post("requestEmailCode", { email: "known@x.test" })).toEqual({ ok: true });
      expect(await post("requestEmailCode", { email: "new@x.test" })).toEqual({ ok: true });

      expect(sent.map((s) => [s.email, s.isNewUser])).toEqual([
        ["known@x.test", false],
        ["new@x.test", true],
      ]);
      // Nothing is created until the code is verified.
      expect((await users()).map((u) => u.email)).toEqual(["known@x.test"]);
    });

    test("with createUser off an unknown address is sent nothing, and answered the same", async () => {
      emailCode = { createUser: false };
      bindAuth();
      await seedUser("known@x.test");

      expect(await post("requestEmailCode", { email: "known@x.test" })).toEqual({ ok: true });
      expect(await post("requestEmailCode", { email: "nobody@x.test" })).toEqual({ ok: true });

      expect(sent.map((s) => s.email)).toEqual(["known@x.test"]);
      expect((await codeRows()).map((r) => r.email)).toEqual(["known@x.test"]);
    });

    test("the address is normalized and a malformed one is a validation error", async () => {
      await post("requestEmailCode", { email: "  Mixed@X.Test " });
      expect(sent[0].email).toBe("mixed@x.test");

      expect(errorsOf(await attempt("requestEmailCode", { email: "not-an-email" }))).toEqual({
        email: ["Invalid email"],
      });
      expect(errorsOf(await attempt("requestEmailCode", { email: ["a@x.test"] }))).toEqual({
        email: ["Invalid email"],
      });
    });

    test("the code and link are stored hashed, never as sent", async () => {
      await post("requestEmailCode", { email: "a@x.test" });
      const [row] = await codeRows();
      const [{ code, token }] = sent;

      expect(code).toMatch(/^\d{6}$/);
      expect(row.pin).not.toContain(code);
      expect(row.token).not.toContain(token);
      expect(row.pin).toMatch(/^h1\.[0-9a-f]{64}$/);
      expect(row.token).toMatch(/^h1\.[0-9a-f]{64}$/);
    });

    test("a new code replaces the outstanding one", async () => {
      await post("requestEmailCode", { email: "a@x.test" });
      await post("requestEmailCode", { email: "a@x.test" });

      expect(await codeRows()).toHaveLength(1);
      const [first, second] = sent;
      if (first.code !== second.code) {
        expect(
          errorsOf(await attempt("verifyEmailCode", { email: "a@x.test", code: first.code })),
        ).toEqual({ code: ["invalid_code"] });
      }
      const { isNewUser } = await post("verifyEmailCode", { email: "a@x.test", code: second.code });
      expect(isNewUser).toBe(true);
    });

    test("code length is configurable", async () => {
      emailCode = { length: 8 };
      bindAuth();
      await post("requestEmailCode", { email: "a@x.test" });
      expect(sent[0].code).toMatch(/^\d{8}$/);
    });

    // --- /auth/email-code/verify ---------------------------------------------

    test("an unknown address is created on verify, once, and is new", async () => {
      await post("requestEmailCode", { email: "new@x.test" });
      const { code } = sent[0];

      const result = await post(
        "verifyEmailCode",
        { email: "new@x.test", code, name: "Ada" },
        { headers: { "x-anon-owner": "anon-123" } },
      );

      expect(result.isNewUser).toBe(true);
      expect(result.session.user.email).toBe("new@x.test");
      const rows: any = await raw.unsafe(
        `SELECT "email", "name", "emailVerifiedAt" FROM "User"`,
      );
      expect([...rows]).toMatchObject([{ email: "new@x.test", name: "Ada" }]);
      expect(rows[0].emailVerifiedAt).not.toBeNull();
      expect(created).toEqual(["new@x.test"]);
      expect(authenticated).toEqual([
        {
          email: "new@x.test",
          isNewUser: true,
          method: "email-code",
          header: "anon-123",
          hasPassword: false,
        },
      ]);
      // Single use.
      expect(await codeRows()).toEqual([]);
      expect(
        errorsOf(await attempt("verifyEmailCode", { email: "new@x.test", code })),
      ).toEqual({ code: ["invalid_code"] });
    });

    test("a returning user signs in and is not new", async () => {
      await seedUser("known@x.test");
      await post("requestEmailCode", { email: "known@x.test" });

      const result = await post("verifyEmailCode", {
        email: "KNOWN@x.test",
        code: sent[0].code,
      });

      expect(result.isNewUser).toBe(false);
      expect(created).toEqual([]);
      expect(authenticated).toMatchObject([
        { email: "known@x.test", isNewUser: false, method: "email-code", hasPassword: false },
      ]);
      expect(await users()).toHaveLength(1);
    });

    test("concurrent verifies of one code create the user exactly once", async () => {
      await post("requestEmailCode", { email: "race@x.test" });
      const { code } = sent[0];

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => attempt("verifyEmailCode", { email: "race@x.test", code })),
      );

      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      for (const o of outcomes.filter((o) => !o.ok)) {
        // SQLite has one connection and refuses a second transaction while
        // the first is open, so there a loser can fail that way instead; on
        // Postgres every loser finds the code claimed.
        if (!url && !((o as any).error instanceof ValidationError)) continue;
        expect(errorsOf(o)).toEqual({ code: ["invalid_code"] });
      }
      expect((await users()).map((u) => u.email)).toEqual(["race@x.test"]);
      expect(created).toEqual(["race@x.test"]);
    });

    test("a failed onUserCreated rolls back the user and leaves the code usable", async () => {
      await post("requestEmailCode", { email: "a@x.test" });
      const { code } = sent[0];
      failOnUserCreated = true;

      const outcome = await attempt("verifyEmailCode", { email: "a@x.test", code });
      expect(outcome.ok).toBe(false);
      expect(await users()).toEqual([]);

      failOnUserCreated = false;
      expect((await post("verifyEmailCode", { email: "a@x.test", code })).isNewUser).toBe(true);
    });

    test("an expired code is refused", async () => {
      await post("requestEmailCode", { email: "a@x.test" });
      await ageCodes(11);

      expect(
        errorsOf(await attempt("verifyEmailCode", { email: "a@x.test", code: sent[0].code })),
      ).toEqual({ code: ["invalid_code"] });
      expect(await users()).toEqual([]);
    });

    test("expiry is configurable", async () => {
      emailCode = { expiresInMinutes: 30 };
      bindAuth();
      await post("requestEmailCode", { email: "a@x.test" });
      await ageCodes(11);

      expect((await post("verifyEmailCode", { email: "a@x.test", code: sent[0].code })).isNewUser).toBe(
        true,
      );
    });

    test("the guess after maxAttempts burns the code, even the right one", async () => {
      await post("requestEmailCode", { email: "a@x.test" });
      const { code } = sent[0];

      for (let i = 0; i < 5; i++) {
        expect(
          errorsOf(await attempt("verifyEmailCode", { email: "a@x.test", code: wrong(code) })),
        ).toEqual({ code: ["invalid_code"] });
      }
      expect(
        errorsOf(await attempt("verifyEmailCode", { email: "a@x.test", code })),
      ).toEqual({ code: ["too_many_attempts"] });
      // Burned: the row is gone, so the right code is now simply invalid.
      expect(await codeRows()).toEqual([]);
      expect(
        errorsOf(await attempt("verifyEmailCode", { email: "a@x.test", code })),
      ).toEqual({ code: ["invalid_code"] });
    });

    test("concurrent wrong guesses cannot exceed maxAttempts", async () => {
      emailCode = { maxAttempts: 3, verifyLimit: { perEmail: false, perIp: false } };
      bindAuth();
      await post("requestEmailCode", { email: "a@x.test" });
      const { code } = sent[0];

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          attempt(
            "verifyEmailCode",
            { email: "a@x.test", code: wrong(code) },
            { ip: `198.51.100.${i}` },
          ),
        ),
      );
      // At most three were compared; the guess that went over burned the
      // code, and any guess that arrived after that found no code at all (an
      // `invalid_code` that compared nothing), so the counts depend on timing.
      // What must hold: some guess went over, and the code is gone.
      const messages = outcomes.map((o) => errorsOf(o).code[0]);
      expect(messages).toContain("too_many_attempts");
      expect(messages.every((m) => m === "invalid_code" || m === "too_many_attempts")).toBe(true);
      expect(await codeRows()).toEqual([]);
      expect(
        errorsOf(await attempt("verifyEmailCode", { email: "a@x.test", code })),
      ).toEqual({ code: ["invalid_code"] });
    });

    test("a request for a new code starts a new attempt count", async () => {
      emailCode = { maxAttempts: 1 };
      bindAuth();
      await post("requestEmailCode", { email: "a@x.test" });
      await attempt("verifyEmailCode", { email: "a@x.test", code: wrong(sent[0].code) });
      await post("requestEmailCode", { email: "a@x.test" });

      expect((await post("verifyEmailCode", { email: "a@x.test", code: sent[1].code })).isNewUser).toBe(
        true,
      );
    });

    // --- rate limits -----------------------------------------------------------

    test("requests are limited per address", async () => {
      emailCode = { requestLimit: { perEmail: [2, 900], perIp: false } };
      bindAuth();
      await post("requestEmailCode", { email: "a@x.test" }, { ip: "198.51.100.1" });
      await post("requestEmailCode", { email: "a@x.test" }, { ip: "198.51.100.2" });
      const outcome = await attempt("requestEmailCode", { email: "a@x.test" }, { ip: "198.51.100.3" });

      expect((outcome as any).error).toBeInstanceOf(RateLimitExceededError);
      expect((outcome as any).error.payload.api.status).toBe(429);
      expect((outcome as any).error.payload.api.data.error.kind).toBe("rate_limit");
      expect(sent).toHaveLength(2);
      // Another address is unaffected.
      expect(await post("requestEmailCode", { email: "b@x.test" })).toEqual({ ok: true });
    });

    test("requests are limited per IP, without spending the address's budget", async () => {
      emailCode = { requestLimit: { perEmail: [2, 900], perIp: [2, 900] } };
      bindAuth();
      await post("requestEmailCode", { email: "a@x.test" }, { ip: "198.51.100.9" });
      await post("requestEmailCode", { email: "b@x.test" }, { ip: "198.51.100.9" });
      const outcome = await attempt("requestEmailCode", { email: "c@x.test" }, { ip: "198.51.100.9" });
      expect((outcome as any).error).toBeInstanceOf(RateLimitExceededError);

      // c@ was refused at the IP, so its own budget is untouched.
      await post("requestEmailCode", { email: "c@x.test" }, { ip: "198.51.100.10" });
      await post("requestEmailCode", { email: "c@x.test" }, { ip: "198.51.100.11" });
    });

    test("verifies are limited per address and per IP", async () => {
      emailCode = {
        maxAttempts: 100,
        verifyLimit: { perEmail: [3, 900], perIp: [4, 900] },
      };
      bindAuth();
      await post("requestEmailCode", { email: "a@x.test" });
      const bad = wrong(sent[0].code);

      for (let i = 0; i < 3; i++) {
        await attempt("verifyEmailCode", { email: "a@x.test", code: bad }, { ip: `198.51.100.${i}` });
      }
      const perEmail = await attempt("verifyEmailCode", { email: "a@x.test", code: bad }, { ip: "198.51.100.50" });
      expect((perEmail as any).error).toBeInstanceOf(RateLimitExceededError);

      for (let i = 0; i < 4; i++) {
        await attempt("verifyEmailCode", { email: `x${i}@x.test`, code: "1" }, { ip: "198.51.100.77" });
      }
      const perIp = await attempt("verifyEmailCode", { email: "y@x.test", code: "1" }, { ip: "198.51.100.77" });
      expect((perIp as any).error).toBeInstanceOf(RateLimitExceededError);
    });

    // --- the magic-link / PIN routes -------------------------------------------

    test("/magic-link keeps its answer, and stores the PIN hashed", async () => {
      await seedUser("known@x.test");

      expect(await post("createMagicLinkToken", { email: "Known@x.test" })).toEqual({
        email: "known@x.test",
      });
      expect(await post("createMagicLinkToken", { email: "nobody@x.test" })).toEqual({
        email: null,
      });

      const [link] = magicLinks;
      expect(link.pin).toMatch(/^\d{6}$/);
      const [row] = await codeRows();
      expect(row.pin).toMatch(/^h1\./);
      expect(row.pin).not.toContain(link.pin);
    });

    test("/magic-link answers every address alike with uniformMagicLinkResponse", async () => {
      emailCode = { uniformMagicLinkResponse: true };
      bindAuth();
      expect(await post("createMagicLinkToken", { email: "nobody@x.test" })).toEqual({
        email: "nobody@x.test",
      });
      expect(magicLinks).toEqual([]);
    });

    test("/magic-link is rate limited", async () => {
      emailCode = { requestLimit: { perEmail: [1, 900] } };
      bindAuth();
      await seedUser("known@x.test");
      await post("createMagicLinkToken", { email: "known@x.test" });
      const outcome = await attempt("createMagicLinkToken", { email: "known@x.test" });
      expect((outcome as any).error).toBeInstanceOf(RateLimitExceededError);
    });

    test.each(["signInWithPin", "signInWithPinV2"] as const)(
      "%s: the PIN works once and keeps its response shape",
      async (action) => {
        await seedUser("known@x.test");
        await post("createMagicLinkToken", { email: "known@x.test" });
        const { pin } = magicLinks[0];

        const result = await post(action, { email: "known@x.test", pin });
        const session = action === "signInWithPin" ? result.session : result;
        expect(session.token).toMatch(/^v2\./);
        expect(session.user.email).toBe("known@x.test");
        expect(authenticated).toMatchObject([
          { email: "known@x.test", isNewUser: false, method: "magic-link" },
        ]);

        expect(errorsOf(await attempt(action, { email: "known@x.test", pin }))).toEqual({
          pin: ["Invalid pin"],
        });
      },
    );

    test.each(["signInWithPin", "signInWithPinV2"] as const)(
      "%s: an expired PIN is the same 'Invalid pin'",
      async (action) => {
        await seedUser("known@x.test");
        await post("createMagicLinkToken", { email: "known@x.test" });
        await ageCodes(11);

        expect(
          errorsOf(await attempt(action, { email: "known@x.test", pin: magicLinks[0].pin })),
        ).toEqual({ pin: ["Invalid pin"] });
      },
    );

    test.each(["signInWithPin", "signInWithPinV2"] as const)(
      "%s: the guess after maxAttempts burns the PIN",
      async (action) => {
        await seedUser("known@x.test");
        await post("createMagicLinkToken", { email: "known@x.test" });
        const { pin } = magicLinks[0];

        for (let i = 0; i < 5; i++) {
          expect(
            errorsOf(await attempt(action, { email: "known@x.test", pin: wrong(pin) })),
          ).toEqual({ pin: ["Invalid pin"] });
        }
        expect(errorsOf(await attempt(action, { email: "known@x.test", pin }))).toEqual({
          pin: ["Too many attempts"],
        });
        expect(errorsOf(await attempt(action, { email: "known@x.test", pin }))).toEqual({
          pin: ["Invalid pin"],
        });
      },
    );

    test("the PIN routes are rate limited per address", async () => {
      emailCode = { maxAttempts: 100, verifyLimit: { perEmail: [2, 900], perIp: false } };
      bindAuth();
      await seedUser("known@x.test");
      await post("createMagicLinkToken", { email: "known@x.test" });
      const bad = wrong(magicLinks[0].pin);

      await attempt("signInWithPinV2", { email: "known@x.test", pin: bad });
      await attempt("signInWithPinV2", { email: "known@x.test", pin: bad });
      const outcome = await attempt("signInWithPinV2", { email: "known@x.test", pin: bad });
      expect((outcome as any).error).toBeInstanceOf(RateLimitExceededError);
    });

    test("a missing or malformed email on a PIN route is 'Invalid pin', not a 500", async () => {
      expect(errorsOf(await attempt("signInWithPinV2", { pin: "123456" }))).toEqual({
        pin: ["Invalid pin"],
      });
    });

    test("generateCode supplies the PIN, and it is still stored hashed", async () => {
      application.instance(
        AuthManager,
        new AuthManager(
          {
            generateCode: (email) => (email === "tester@x.test" ? "424242" : undefined),
            onMagicLinkCreated: async (_user: any, args: any) => {
              magicLinks.push(args);
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
      await seedUser("tester@x.test");
      await seedUser("other@x.test");
      await post("createMagicLinkToken", { email: "tester@x.test" });
      await post("createMagicLinkToken", { email: "other@x.test" });

      expect(magicLinks[0].pin).toBe("424242");
      expect(magicLinks[1].pin).not.toBe("424242");
      expect((await codeRows()).every((r) => !r.pin.includes("424242"))).toBe(true);
      const result = await post("signInWithPinV2", { email: "tester@x.test", pin: "424242" });
      expect(result.user.email).toBe("tester@x.test");
    });

    test("a plain-text row from before the upgrade still verifies until it expires", async () => {
      await seedUser("known@x.test");
      await raw.unsafe(
        `INSERT INTO "MagicLinkToken" ("email", "token", "pin") VALUES ('known@x.test', 'legacy-token', '135790')`,
      );

      expect(
        errorsOf(await attempt("signInWithPinV2", { email: "known@x.test", pin: "135791" })),
      ).toEqual({ pin: ["Invalid pin"] });
      const result = await post("signInWithPinV2", { email: "known@x.test", pin: "135790" });
      expect(result.user.email).toBe("known@x.test");
    });

    // --- /auth/sign-in/magic-link ---------------------------------------------

    async function clickLink(email: string, token: string) {
      const req = new HttpRequest(
        new Request(
          `http://localhost/auth/sign-in/magic-link?email=${encodeURIComponent(email)}&token=${token}`,
          { headers: { "User-Agent": "test-agent" } },
        ),
        {},
        "view",
      );
      return await RequestContext.run(req as never, () =>
        new AuthController().signInWithMagicLink(req as never),
      );
    }

    test("the link signs in once, and not after it expires", async () => {
      await seedUser("known@x.test");
      await post("createMagicLinkToken", { email: "known@x.test" });
      const { token } = magicLinks[0];

      expect(await clickLink("known@x.test", "f".repeat(64))).toEqual({ error: "Invalid token" });
      const first: any = await clickLink("Known@x.test", token);
      expect(first.session.user.email).toBe("known@x.test");
      expect(await clickLink("known@x.test", token)).toEqual({ error: "Invalid token" });

      await post("createMagicLinkToken", { email: "known@x.test" });
      await ageCodes(7 * 24 * 60 + 1);
      expect(await clickLink("known@x.test", magicLinks[1].token)).toEqual({
        error: "Invalid token",
      });
    });

    test("the link outlives the PIN", async () => {
      await seedUser("known@x.test");
      await post("createMagicLinkToken", { email: "known@x.test" });
      await ageCodes(60);

      const result: any = await clickLink("known@x.test", magicLinks[0].token);
      expect(result.session.user.email).toBe("known@x.test");
    });
  });
}

suite("email code (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("email code (postgres)", POSTGRES_URL);
} else {
  describe.skip("email code (postgres) — set TEST_POSTGRES_URL to run", () => {
    test("skipped", () => {});
  });
}
