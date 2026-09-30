import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { HttpRequest } from "gemi/http";
import { UserProvider } from "gemi/kernel";
import { clearPlanCache } from "gemi/orm";
import { AuthManager } from "gemi/services";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// Neither is a public export: the controller is reached through the route
// table, and the request scope is the server's. Reached by path through the
// linked package, as `oauth-callback.test.ts` does.
import { AuthController } from "../../node_modules/gemi/auth/AuthController";
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
 * `auth.migrateLegacySession` against a real database, through the real
 * `AuthManager`, `UserProvider` and `AuthController.signOut` — #638.
 *
 * Two things were wrong. Signing out with the old token after it was converted
 * deleted only the old row, long gone, so the converted session lived on; and
 * a sign-out landing between a conversion's read of the old row and its write
 * of the new one was overtaken by it, leaving a live session behind the
 * sign-out. A conversion and a sign-out of one old token now run one after the
 * other under `UserProvider.withLegacySessionLock`, and a conversion writes
 * the new row only if it is the one that deleted the old.
 *
 * The interleavings are driven, not slept into: a gate holds one side at a
 * chosen point, and on Postgres `pg_locks` says when the other side is waiting
 * on it.
 */

const UA = "MyApp iOS/1.0";
const HOUR = 3_600_000;

/** A gate a hook waits on until the test opens it, and a latch the test waits on until the hook is reached. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { open, opened, reach, reached };
}

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;
    let provider: UserProvider;
    let manager: AuthManager;
    let userId: number;
    /** What the app's `migrateLegacySession` does; a test may replace it. */
    let migrate: () => boolean | Promise<boolean>;

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
        workspace = mkdtempSync(join(tmpdir(), "gemi-legacy-session-"));
        const path = join(workspace, "sessions.db");
        await applyMigrations(path);
        target = `sqlite://${path}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      provider = new UserProvider({
        User: UserModel,
        Session: SessionModel,
        Account: AccountModel,
        PasswordResetToken: PasswordResetTokenModel,
        MagicLinkToken: MagicLinkTokenModel,
        OrganizationInvitation: OrganizationInvitationModel,
        SocialAccount: SocialAccountModel,
      });
      manager = new AuthManager({ migrateLegacySession: () => migrate() }, provider);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      application.instance(AuthManager, manager as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      vi.stubEnv("SECRET", "test-secret");
      clearPlanCache();
      migrate = () => true;
      if (url) {
        await raw.unsafe(
          `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
        );
      } else {
        for (const table of TABLES) await raw.unsafe(`DELETE FROM "${table}"`);
      }
      const rows: any = await raw.unsafe(
        `INSERT INTO "User" ("publicId", "email", "name", "locale", "updatedAt") VALUES ('pub-a', 'a@x.test', 'A', 'en-US', CURRENT_TIMESTAMP) RETURNING "id"`,
      );
      userId = rows[0].id;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    /** A pre-0.64 row: a bare hex token, expiry columns never enforced and long past. */
    async function seedLegacy() {
      const token = randomBytes(32).toString("hex");
      await provider.createSessionV2({
        token,
        userId,
        userAgent: UA,
        expiresAt: new Date(Date.now() - 30 * 24 * HOUR),
        absoluteExpiresAt: new Date(Date.now() - 2 * 24 * HOUR),
      });
      return token;
    }

    function inRequest<T>(headers: Record<string, string>, fn: (req: HttpRequest<any, any>) => Promise<T>) {
      const req = new HttpRequest(
        new Request("http://localhost/api/me", { headers: { "User-Agent": UA, ...headers } }),
        {},
        "api",
      );
      return RequestContext.run(req as never, async () => {
        const result = await fn(req);
        const cookie = [...RequestContext.getStore().cookies]
          .find((c: string) => c.startsWith("access_token="))
          ?.split(";")[0]
          .slice("access_token=".length);
        return { result, cookie };
      });
    }

    /** A request carrying `token`, resolved as the `auth` middleware resolves it. */
    const me = (token: string) =>
      inRequest({ Cookie: `access_token=${token}` }, () => manager.getSession(token, UA));

    const signOut = (token: string) =>
      inRequest({ Cookie: `access_token=${token}` }, (req) => new AuthController().signOut(req as never));

    async function tokens() {
      const rows: any = await raw.unsafe(`SELECT "token" FROM "Session" ORDER BY "id"`);
      return [...rows].map((row: { token: string }) => row.token);
    }

    // --- signing out after the conversion -----------------------------------

    test("signing out with the old token within the grace window ends the converted session", async () => {
      const old = await seedLegacy();
      // Converted early in a grace bucket, so ten minutes on is the next one.
      const start = Math.floor(Date.now() / 600_000) * 600_000 + 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(start);
      const { result: converted } = await me(old);
      expect(converted!.token).toMatch(/^v2\./);

      // The next bucket, where the old token still resolves to it.
      clock.mockReturnValue(start + 10 * 60_000);
      await signOut(old);

      expect(await tokens()).toEqual([]);
      expect((await me(converted!.token as string)).result).toBeNull();
      expect((await me(old)).result).toBeNull();
    });

    test("after the grace window the old token revokes nothing, as it grants nothing", async () => {
      const old = await seedLegacy();
      const { result: converted } = await me(old);

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 21 * 60_000);
      await signOut(old);

      expect(await tokens()).toEqual([converted!.token]);
      expect((await me(converted!.token as string)).result!.user.id).toBe(userId);
    });

    test("signing out with the old token before any conversion deletes its row", async () => {
      const old = await seedLegacy();
      await signOut(old);
      expect(await tokens()).toEqual([]);
      expect((await me(old)).result).toBeNull();
    });

    test("requests converting one token at once land in one session", async () => {
      const old = await seedLegacy();
      // Every request reads the old row and is let through by the app before
      // any of them writes.
      let asked = 0;
      const allAsked = gate();
      migrate = async () => {
        if (++asked === 3) allAsked.open();
        await allAsked.opened;
        return true;
      };

      const results = await Promise.all([me(old), me(old), me(old)]);

      const issued = new Set(results.map(({ result }) => result!.token));
      expect(issued.size).toBe(1);
      expect(results.map(({ cookie }) => cookie)).toEqual(Array(3).fill([...issued][0]));
      expect(await tokens()).toEqual([...issued]);
    });

    // --- a sign-out racing a conversion -------------------------------------

    test("a sign-out that commits between the conversion's read and its write leaves no session", async () => {
      const old = await seedLegacy();
      // The conversion has read the old row and is waiting on the app's answer.
      const asked = gate();
      migrate = async () => {
        asked.reach();
        await asked.opened;
        return true;
      };

      const converting = me(old);
      await asked.reached;
      await signOut(old);
      asked.open();
      const { result, cookie } = await converting;

      expect(result).toBeNull();
      expect(cookie).toBeUndefined();
      expect(await tokens()).toEqual([]);
    });
  });
}

/**
 * Until `pending` settles or a backend is waiting on an advisory lock,
 * whichever comes first: either way the other side has gone as far as it can.
 * Answers which it was.
 */
async function settledOrBlocked(raw: SQL, pending: Promise<unknown>): Promise<"settled" | "blocked"> {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 1000 && !settled; i++) {
    const [{ waiting }]: any = await raw.unsafe(
      `SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
    );
    if (waiting > 0) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!settled) throw new Error("neither settled nor blocked on the advisory lock");
  return "settled";
}

/**
 * The interleavings a lock decides, which need a server with more than one
 * connection to happen at all. SQLite runs one statement at a time on one
 * connection, and `withLegacySessionLock` queues these transactions in the
 * process there.
 */
function interleavings(url: string) {
  describe("legacy session sign-out interleavings (postgres)", () => {
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;
    let provider: UserProvider;
    let manager: AuthManager;
    let userId: number;
    let migrate: () => boolean | Promise<boolean>;

    beforeAll(async () => {
      database = new DatabaseManager({ url });
      raw = new SQL(url);
      provider = new UserProvider({
        User: UserModel,
        Session: SessionModel,
        Account: AccountModel,
        PasswordResetToken: PasswordResetTokenModel,
        MagicLinkToken: MagicLinkTokenModel,
        OrganizationInvitation: OrganizationInvitationModel,
        SocialAccount: SocialAccountModel,
      });
      manager = new AuthManager({ migrateLegacySession: () => migrate() }, provider);
      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      application.instance(AuthManager, manager as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
    });

    beforeEach(async () => {
      vi.stubEnv("SECRET", "test-secret");
      clearPlanCache();
      migrate = () => true;
      await raw.unsafe(
        `TRUNCATE "SocialAccount", "Session", "PasswordResetToken", "MagicLinkToken", "Account", "User", "OrganizationInvitation", "Organization" RESTART IDENTITY CASCADE`,
      );
      const rows: any = await raw.unsafe(
        `INSERT INTO "User" ("publicId", "email", "name", "locale", "updatedAt") VALUES ('pub-a', 'a@x.test', 'A', 'en-US', CURRENT_TIMESTAMP) RETURNING "id"`,
      );
      userId = rows[0].id;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    async function seedLegacy() {
      const token = randomBytes(32).toString("hex");
      await raw.unsafe(
        `INSERT INTO "Session" ("token", "userId", "userAgent", "expiresAt", "absoluteExpiresAt") VALUES ($1, $2, $3, now() - interval '30 days', now() - interval '2 days')`,
        [token, userId, UA],
      );
      return token;
    }

    function inRequest<T>(fn: (req: HttpRequest<any, any>) => Promise<T>, token: string) {
      const req = new HttpRequest(
        new Request("http://localhost/api/me", {
          headers: { "User-Agent": UA, Cookie: `access_token=${token}` },
        }),
        {},
        "api",
      );
      return RequestContext.run(req as never, () => fn(req));
    }

    const me = (token: string) => inRequest(() => manager.getSession(token, UA), token);
    const signOut = (token: string) =>
      inRequest((req) => new AuthController().signOut(req as never), token);

    async function tokens() {
      const rows: any = await raw.unsafe(`SELECT "token" FROM "Session" ORDER BY "id"`);
      return [...rows].map((row: { token: string }) => row.token);
    }

    test("a sign-out paused after its read, while a conversion commits, still leaves no session", async () => {
      const old = await seedLegacy();
      // Hold the sign-out once it has looked the old token up, before it
      // deletes anything.
      const paused = gate();
      const findSession = provider.findSession.bind(provider);
      let armed = true;
      vi.spyOn(provider, "findSession").mockImplementation(async (args) => {
        const found = await findSession(args);
        if (armed && args.token === old) {
          armed = false;
          paused.reach();
          await paused.opened;
        }
        return found;
      });

      const signingOut = signOut(old);
      await paused.reached;
      // A request with the old cookie arrives now and converts it.
      const converting = me(old);
      const conversion = await settledOrBlocked(raw, converting);
      paused.open();
      await signingOut;
      const converted = await converting;

      expect(await tokens()).toEqual([]);
      if (converted) {
        expect(await me(converted.token as string)).toBeNull();
      }
      expect(await me(old)).toBeNull();
      // And it was the lock that decided it: the conversion waited for the
      // sign-out rather than committing under it.
      expect(conversion).toBe("blocked");
      expect(converted).toBeNull();
    });

    test("a conversion paused after its read, while a sign-out commits, writes no session", async () => {
      const old = await seedLegacy();
      // Hold the conversion once it has read the old row, before any write.
      const paused = gate();
      migrate = async () => {
        paused.reach();
        await paused.opened;
        return true;
      };

      const converting = me(old);
      await paused.reached;
      const signingOut = signOut(old);
      // Nothing holds the lock yet, so the sign-out commits on its own.
      expect(await settledOrBlocked(raw, signingOut)).toBe("settled");
      await signingOut;
      paused.open();
      const converted = await converting;

      expect(converted).toBeNull();
      expect(await tokens()).toEqual([]);
    });

    test("a sign-out arriving while a conversion is writing waits for it, then ends the converted session", async () => {
      const old = await seedLegacy();
      // Hold the conversion just before it writes the new row: on the fixed
      // path that is inside its transaction, holding the lock.
      const paused = gate();
      const createSessionV2 = provider.createSessionV2.bind(provider);
      vi.spyOn(provider, "createSessionV2").mockImplementation(async (args) => {
        paused.reach();
        await paused.opened;
        return createSessionV2(args);
      });

      const converting = me(old);
      await paused.reached;
      const signingOut = signOut(old);
      const signOutState = await settledOrBlocked(raw, signingOut);
      paused.open();
      const converted = await converting;
      await signingOut;

      expect(await tokens()).toEqual([]);
      if (converted) {
        expect(await me(converted.token as string)).toBeNull();
      }
      expect(await me(old)).toBeNull();
      expect(signOutState).toBe("blocked");
    });
  });
}

suite("legacy session migration (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("legacy session migration (postgres)", POSTGRES_URL);
  interleavings(POSTGRES_URL);
} else {
  describe("legacy session migration (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
