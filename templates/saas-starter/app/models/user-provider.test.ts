import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UserProvider } from "gemi/kernel";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { clearPlanCache } from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL, applyMigrations } from "./scratch";
import {
  AccountModel,
  MagicLinkTokenModel,
  OrganizationInvitationModel,
  OrganizationModel,
  PasswordResetTokenModel,
  SessionModel,
  SocialAccountModel,
  UserModel,
} from "./generated";

/**
 * `UserProvider` — the framework's authentication persistence, all twenty-two
 * methods.
 *
 * `plans/orm/README.md` schedules this for "once iteration 4 lands writes", and
 * it is what let the Prisma adapter be retired — PR #33's stated goal, and the
 * reason its proposed hand-written `SqlUserProvider` was dropped in favour of
 * building the ORM first. It is now the only implementation: the
 * `IAuthenticationAdapter` seam is gone and `AuthManager` constructs this
 * directly, so these twenty-two methods are the auth path rather than one
 * selectable option for it.
 *
 * Models are injected here rather than left to default to the registry, which is
 * the constructor's other purpose: the suite points them at a scratch database
 * per dialect.
 *
 * It is also the ORM's most demanding end-to-end exercise so far, and that is
 * half the point of the test: twenty-two methods written against a real
 * application's needs rather than against the compiler's known surface. Every
 * one of `findUnique` with an extra filter, a compound `@@unique`, a nested
 * `connect`, a two-level `select` through a relation, and `deleteMany`-as-idempotent
 * -delete appears here because the auth flow needs it, not because a test wanted
 * coverage.
 */

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;
    let auth: UserProvider;

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
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-auth-"));
        const path = join(workspace, "auth.db");
        await applyMigrations(path);
        target = `sqlite://${path}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);

      auth = new UserProvider({
        User: UserModel,
        Session: SessionModel,
        Account: AccountModel,
        PasswordResetToken: PasswordResetTokenModel,
        MagicLinkToken: MagicLinkTokenModel,
        OrganizationInvitation: OrganizationInvitationModel,
        SocialAccount: SocialAccountModel,
      });
    }, 120_000);

    afterAll(async () => {
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      if (url) {
        await raw.unsafe(
          `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
        );
      } else {
        for (const table of TABLES) await raw.unsafe(`DELETE FROM "${table}"`);
      }
    });

    const session = (userId: number, token = "tok") => ({
      token,
      userId,
      userAgent: "test-agent",
      expiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    });

    // --- users -------------------------------------------------------------

    test("createUser", async () => {
      const user: any = await auth.createUser({
        name: "Alice",
        email: "alice@x.test",
        password: "hashed",
      });

      expect(user.id).toBeGreaterThan(0);
      expect(user.email).toBe("alice@x.test");
      // Client-side defaults from the schema, applied by the ORM rather than the
      // database — a cuid and a locale.
      expect(user.publicId).toMatch(/^c/);
      expect(user.locale).toBe("en-US");
    });

    /**
     * The password must not come back, and this is not defensive tidying:
     * `auth/routes.ts` maps `POST /sign-up` to `AuthController.signUp`, whose
     * handler ends `return newUser` — so whatever `createUser` returns is the
     * response body of an unauthenticated endpoint. The same object reaches
     * `config.onSignUp`, so a hook that logs its argument would log a credential
     * hash.
     *
     * An earlier version of this adapter returned the row whole and documented
     * the difference. That was wrong: the framework itself is the caller that
     * serialises it.
     */
    test("createUser does not return the password", async () => {
      const user: any = await auth.createUser({
        name: "Alice",
        email: "alice@x.test",
        password: "hashed",
      });

      expect("password" in user).toBe(false);

      // ...and it was still stored, so the strip is on the way out only.
      const stored: any = await raw.unsafe(
        `SELECT "password" FROM "User" WHERE "email" = 'alice@x.test'`,
      );
      expect([...stored][0].password).toBe("hashed");
    });

    test("updateUserPassword does not return the password either", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      const updated: any = await auth.updateUserPassword({
        id: user.id,
        password: "new-hash",
      });

      expect("password" in updated).toBe(false);

      const stored: any = await raw.unsafe(
        `SELECT "password" FROM "User" WHERE "id" = ${user.id}`,
      );
      expect([...stored][0].password).toBe("new-hash");
    });

    test("findUserByEmailAddress without verification", async () => {
      await auth.createUser({ name: "A", email: "a@x.test" });
      const found: any = await auth.findUserByEmailAddress("a@x.test", false);
      expect(found.email).toBe("a@x.test");
    });

    /**
     * `findUnique` with an extra non-unique filter — a Prisma 5
     * `WhereUniqueInput`, which the ORM honours because the unique key is
     * present and the rest narrows further.
     */
    test("findUserByEmailAddress with verification excludes the unverified", async () => {
      await auth.createUser({ name: "A", email: "a@x.test" });

      expect(await auth.findUserByEmailAddress("a@x.test", true)).toBeNull();

      await auth.verifyUser("a@x.test");
      const verified: any = await auth.findUserByEmailAddress("a@x.test", true);
      expect(verified.emailVerifiedAt).toBeInstanceOf(Date);
    });

    test("findUserByVerificationToken", async () => {
      await auth.createUser({
        name: "A",
        email: "a@x.test",
        verificationToken: "verify-me",
      });

      const found: any = await auth.findUserByVerificationToken("verify-me");
      expect(found.email).toBe("a@x.test");
      expect(await auth.findUserByVerificationToken("nope")).toBeNull();
    });

    test("updateUserPassword", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      const updated: any = await auth.updateUserPassword({
        id: user.id,
        password: "new-hash",
      });

      // `@updatedAt` is stamped by the ORM on every update.
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        user.updatedAt.getTime(),
      );
    });

    // --- sessions ----------------------------------------------------------

    test("createSession includes the whole user", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      const created: any = await auth.createSession(session(user.id));

      expect(created.token).toBe("tok");
      expect(created.user.email).toBe("a@x.test");
    });

    /**
     * The deepest query in the adapter: a `select` on the session, a relation
     * inside it, and a relation *inside that* — `user.accounts[].organization`.
     * Three levels, which is what the interface's `User` type requires.
     */
    test("createSessionV2 selects the user with accounts and organizations", async () => {
      const org: any = await OrganizationModel.create({ data: { name: "Acme" } });
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      await auth.createAccount({
        userId: user.id,
        organizationId: org.id,
        organizationRole: 0,
      });

      const created: any = await auth.createSessionV2(session(user.id));

      expect(created.user.email).toBe("a@x.test");
      expect(created.user.accounts).toHaveLength(1);
      expect(created.user.accounts[0].organization.name).toBe("Acme");
      // The narrowed select must not carry the password into something handed
      // to a client.
      expect("password" in created.user).toBe(false);

      // The organizations arrive through the accounts, and the user row itself
      // carries no organization column. This schema happens to have one, so
      // selecting it would pass here — which is exactly how the framework came
      // to require a column no application should have to declare. Asserted as
      // an absence so that re-adding it fails.
      expect("organizationId" in created.user).toBe(false);
    });

    test("findSession returns the session with its user", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      await auth.createSession(session(user.id));

      const found: any = await auth.findSession({
        token: "tok",
        userAgent: "test-agent",
      });
      expect(found.user.email).toBe("a@x.test");
      expect("password" in found.user).toBe(false);
    });

    test("findSession returns null for an unknown or empty token", async () => {
      expect(await auth.findSession({ token: "", userAgent: "a" })).toBeNull();
      expect(await auth.findSession({ token: "nope", userAgent: "a" })).toBeNull();
    });

    test("updateSession extends the expiry", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      await auth.createSession(session(user.id));

      const later = new Date(Date.now() + 7_200_000);
      const updated: any = await auth.updateSession({
        token: "tok",
        expiresAt: later,
      });

      expect(updated.expiresAt.getTime()).toBe(later.getTime());
      expect(updated.user.email).toBe("a@x.test");
    });

    // `deleteMany` rather than `delete`, so signing out twice does not raise.
    test("deleteSession is idempotent", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      await auth.createSession(session(user.id));

      await auth.deleteSession({ token: "tok" });
      await expect(auth.deleteSession({ token: "tok" })).resolves.toBeUndefined();

      expect(await auth.findSession({ token: "tok", userAgent: "a" })).toBeNull();
    });

    test("deleteAllUserSessions", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      await auth.createSession(session(user.id, "one"));
      await auth.createSession(session(user.id, "two"));

      await auth.deleteAllUserSessions(user.id);

      const rows: any = await raw.unsafe(`SELECT "id" FROM "Session"`);
      expect([...rows]).toHaveLength(0);
    });

    // --- password reset ----------------------------------------------------

    // A nested `connect` on the owning side, which becomes a bound column with
    // no extra query because the connect names the referenced field.
    test("createPasswordResetToken connects the user", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      await auth.createPasswordResetToken({ user, token: "reset-me" });

      const found: any = await auth.findPasswordResetToken({ token: "reset-me" });
      expect(found.user.email).toBe("a@x.test");
      expect(found.userId).toBe(user.id);
    });

    test("deletePasswordResetToken", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });
      await auth.createPasswordResetToken({ user, token: "reset-me" });

      await auth.deletePasswordResetToken({ token: "reset-me" });
      expect(await auth.findPasswordResetToken({ token: "reset-me" })).toBeNull();
    });

    // --- invitations and accounts -----------------------------------------

    test("findInvitation and deleteInvitationById", async () => {
      const org: any = await OrganizationModel.create({ data: { name: "Acme" } });
      const invitation: any = await OrganizationInvitationModel.create({
        data: { organizationId: org.id, email: "invitee@x.test", role: 1 },
      });

      const found: any = await auth.findInvitation(
        invitation.publicId,
        "invitee@x.test",
      );
      expect(found.role).toBe(1);

      // Wrong email, same id — must not match.
      expect(
        await auth.findInvitation(invitation.publicId, "other@x.test"),
      ).toBeNull();

      await auth.deleteInvitationById(invitation.publicId);
      const rows: any = await raw.unsafe(
        `SELECT "id" FROM "OrganizationInvitation"`,
      );
      expect([...rows]).toHaveLength(0);
    });

    test("createAccount", async () => {
      const org: any = await OrganizationModel.create({ data: { name: "Acme" } });
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });

      const account: any = await auth.createAccount({
        userId: user.id,
        organizationId: org.id,
        organizationRole: 2,
      });

      expect(account.organizationRole).toBe(2);
      expect(account.userId).toBe(user.id);
    });

    // --- magic links -------------------------------------------------------

    /**
     * Prisma's compound-unique form: one key named after the fields joined by
     * `_`. The schema declares both `@@unique([token, email])` and
     * `@@unique([pin, email])`, so this exercises the ORM choosing between two
     * composite keys on one model depending on which the caller supplied.
     */
    test("findUserMagicLinkToken by token, and by pin", async () => {
      await auth.createMagicLinkToken({
        email: "a@x.test",
        token: "link-token",
        pin: "123456",
      });

      const byToken: any = await auth.findUserMagicLinkToken({
        email: "a@x.test",
        token: "link-token",
      });
      expect(byToken.pin).toBe("123456");

      const byPin: any = await auth.findUserMagicLinkToken({
        email: "a@x.test",
        pin: "123456",
      });
      expect(byPin.token).toBe("link-token");

      // The compound key is (token, email) — a right token with a wrong email
      // must not match.
      expect(
        await auth.findUserMagicLinkToken({
          email: "other@x.test",
          token: "link-token",
        }),
      ).toBeNull();
    });

    test("deleteMagicLinkToken removes every token for the address", async () => {
      await auth.createMagicLinkToken({
        email: "a@x.test",
        token: "t1",
        pin: "111111",
      });
      await auth.createMagicLinkToken({
        email: "a@x.test",
        token: "t2",
        pin: "222222",
      });

      await auth.deleteMagicLinkToken("a@x.test");

      const rows: any = await raw.unsafe(`SELECT "id" FROM "MagicLinkToken"`);
      expect([...rows]).toHaveLength(0);
    });

    // --- social accounts ---------------------------------------------------

    test("createSocialAccount", async () => {
      const user: any = await auth.createUser({ name: "A", email: "a@x.test" });

      const social: any = await auth.createSocialAccount({
        provider: "github",
        providerId: "gh-1",
        username: "alice",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: new Date(Date.now() + 3_600_000),
        userId: user.id,
      });

      expect(social.provider).toBe("github");
      expect(social.userId).toBe(user.id);
    });
  });
}

suite("orm auth adapter (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("orm auth adapter (postgres)", POSTGRES_URL);
} else {
  describe("orm auth adapter (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
