import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AuthManager } from "./AuthManager";
import { Application } from "../foundation/Application";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { AuthenticationError } from "../http/errors";

/**
 * Sessions against an in-memory provider: the token is minted, not derived;
 * a sign-in never lands in somebody else's row; expiry is enforced; and a
 * token from before all that is no session at all.
 */

const HOUR = 3_600_000;
const UA = "MyApp iOS/1.0";

type Row = {
  token: string;
  userId: number;
  userAgent: string | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
};

class MemoryProvider {
  users = [
    { id: 1, email: "a@example.com" },
    { id: 2, email: "b@example.com" },
  ];
  rows = new Map<string, Row>();

  private withUser(row: Row) {
    return { ...row, user: { ...this.users.find((u) => u.id === row.userId)! } };
  }
  async findUserByEmailAddress(email: string) {
    return this.users.find((u) => u.email === email) ?? null;
  }
  async createSessionV2(args: Row) {
    if (this.rows.has(args.token)) throw new Error("unique violation on token");
    this.rows.set(args.token, { ...args });
    return this.withUser(args);
  }
  async findSession({ token }: { token: string }) {
    const row = this.rows.get(token);
    return row ? this.withUser(row) : null;
  }
  async updateSession(args: { token: string; expiresAt: Date }) {
    const row = this.rows.get(args.token)!;
    row.expiresAt = args.expiresAt;
    return this.withUser(row);
  }
  async deleteSession({ token }: { token: string }) {
    this.rows.delete(token);
  }
  async claimLegacySession({ token }: { token: string }) {
    return this.rows.delete(token);
  }
  // One at a time, as the real lock makes them; there is no transaction to
  // roll back here.
  private tail: Promise<unknown> = Promise.resolve();
  withLegacySessionLock<T>(_token: string, fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

const legacyToken = (email: string) => createHash("sha256").update(`${email}${UA}`).digest("hex");

let provider: MemoryProvider;
let auth: AuthManager;
const previousApp = Application.getInstance();
const previousSecret = process.env.SECRET;

beforeEach(() => {
  process.env.SECRET = "test-secret";
  Application.setInstance(new Application());
  provider = new MemoryProvider();
  auth = new AuthManager({}, provider as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousApp) Application.setInstance(previousApp);
  process.env.SECRET = previousSecret;
});

function inRequest<T>(
  headers: Record<string, string>,
  fn: (req: HttpRequest<any, any>) => Promise<T>,
) {
  const req = new HttpRequest(
    new Request("https://app.example/api/me", { headers: { "User-Agent": UA, ...headers } }),
    {},
    "api",
  );
  return RequestContext.run(req, async () => {
    const result = await fn(req);
    return { result, cookies: [...RequestContext.getStore().cookies] };
  });
}

const accessTokenCookie = (cookies: string[]) =>
  cookies
    .find((c) => c.startsWith("access_token="))
    ?.split(";")[0]
    .slice("access_token=".length);

function seedLegacy(userId: number, email: string, overrides: Partial<Row> = {}) {
  const token = legacyToken(email);
  provider.rows.set(token, {
    token,
    userId,
    userAgent: UA,
    // Written at some sign-in long ago and never checked since.
    expiresAt: new Date(Date.now() - 30 * 24 * HOUR),
    absoluteExpiresAt: new Date(Date.now() - 2 * 24 * HOUR),
    ...overrides,
  });
  return token;
}

describe("signing in", () => {
  test("mints a new, unguessable token on every sign-in", async () => {
    const { result: first } = await inRequest({}, () =>
      auth.createOrUpdateSession({ email: "a@example.com", id: 1 }),
    );
    const { result: second } = await inRequest({}, () =>
      auth.createOrUpdateSession({ email: "a@example.com", id: 1 }),
    );

    expect(first.token).toMatch(/^v2\.[0-9a-f]{64}$/);
    expect(second.token).not.toBe(first.token);
    expect(first.token).not.toContain(legacyToken("a@example.com"));
    expect(provider.rows.size).toBe(2);
  });

  test("never lands in a row another user owns, even under the same email and client", async () => {
    // A signed in, then gave up the address; B holds it now.
    const aToken = seedLegacy(1, "shared@example.com");
    provider.users[0].email = "a-new@example.com";
    provider.users[1].email = "shared@example.com";

    const { result } = await inRequest({}, () =>
      auth.createOrUpdateSession({ email: "shared@example.com" }),
    );

    expect(result.user.id).toBe(2);
    expect(provider.rows.get(aToken)!.userId).toBe(1);
  });

  test("refuses when the user no longer exists", async () => {
    await expect(
      inRequest({}, () => auth.createOrUpdateSession({ email: "gone@example.com" })),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  /**
   * "Two mints differ" is satisfied by a one-byte nonce 255 times out of 256,
   * and by any counter. Minting many and requiring every one to be distinct
   * is what a narrowed nonce fails: at one byte the collision is certain, at
   * two it is all but certain. It cannot tell a CSPRNG from a well-spread
   * PRNG — that is what naming `randomBytes` in the source is for — but it
   * does hold the width.
   */
  test("mints from a wide enough nonce that 512 tokens never repeat", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 512; i++) {
      const { result } = await inRequest({}, () =>
        auth.createOrUpdateSession({ email: "a@example.com", id: 1 }),
      );
      tokens.add(result.token as string);
    }
    expect(tokens.size).toBe(512);
  });

  test("refuses to mint without a secret", async () => {
    delete process.env.SECRET;
    await expect(
      inRequest({}, () => auth.createOrUpdateSession({ email: "a@example.com", id: 1 })),
    ).rejects.toThrow(/Set SECRET/);
  });
});

describe("expiry", () => {
  async function signIn() {
    const { result } = await inRequest({}, () =>
      auth.createOrUpdateSession({ email: "a@example.com", id: 1 }),
    );
    return result.token as string;
  }

  test("an idle session past expiresAt is gone, row and all", async () => {
    const token = await signIn();
    provider.rows.get(token)!.expiresAt = new Date(Date.now() - 1000);

    const { result } = await inRequest({ access_token: token }, () => auth.getSession(token, UA));
    expect(result).toBeNull();
    expect(provider.rows.has(token)).toBe(false);
  });

  test("so is one past absoluteExpiresAt, however recently it was used", async () => {
    const token = await signIn();
    provider.rows.get(token)!.absoluteExpiresAt = new Date(Date.now() - 1000);

    const { result } = await inRequest({ access_token: token }, () => auth.getSession(token, UA));
    expect(result).toBeNull();
  });

  test("a session in use slides forward, but not past its absolute end", async () => {
    const token = await signIn();
    const row = provider.rows.get(token)!;
    row.expiresAt = new Date(Date.now() + HOUR);
    row.absoluteExpiresAt = new Date(Date.now() + 3 * HOUR);

    const { result, cookies } = await inRequest({ Cookie: `access_token=${token}` }, () =>
      auth.getSession(token, UA),
    );

    expect(result!.user.id).toBe(1);
    expect(row.expiresAt.getTime()).toBe(row.absoluteExpiresAt.getTime());
    expect(accessTokenCookie(cookies)).toBe(token);
  });

  test("a fresh session is not rewritten on every request", async () => {
    const token = await signIn();
    const before = provider.rows.get(token)!.expiresAt.getTime();

    const { cookies } = await inRequest({ Cookie: `access_token=${token}` }, () =>
      auth.getSession(token, UA),
    );

    expect(provider.rows.get(token)!.expiresAt.getTime()).toBe(before);
    expect(accessTokenCookie(cookies)).toBeUndefined();
  });
});

describe("a token from before the upgrade, when the app has not opted in", () => {
  test("is no session, however live its row", async () => {
    const legacy = seedLegacy(1, "a@example.com", {
      expiresAt: new Date(Date.now() + 24 * HOUR),
      absoluteExpiresAt: new Date(Date.now() + 24 * HOUR),
    });
    const findSession = vi.spyOn(provider, "findSession");

    for (const headers of [{ Cookie: `access_token=${legacy}` }, { access_token: legacy }]) {
      const { result, cookies } = await inRequest(headers, () => auth.getSession(legacy, UA));
      expect(result).toBeNull();
      expect(accessTokenCookie(cookies)).toBeUndefined();
    }
    expect(findSession).not.toHaveBeenCalled();
    expect(provider.rows.size).toBe(1);
  });

  test("signing out with it deletes its row and nothing else, as before", async () => {
    const legacy = seedLegacy(1, "a@example.com", {
      expiresAt: new Date(Date.now() + 24 * HOUR),
      absoluteExpiresAt: new Date(Date.now() + 24 * HOUR),
    });
    const findSession = vi.spyOn(provider, "findSession");
    const lock = vi.spyOn(provider, "withLegacySessionLock");

    const revoked = await auth.revokeSession(legacy, UA);

    expect(revoked!.user.id).toBe(1);
    expect(findSession.mock.calls.map(([args]) => args.token)).toEqual([legacy]);
    expect(lock).not.toHaveBeenCalled();
    expect(provider.rows.size).toBe(0);
  });
});

/**
 * `new Date(undefined).getTime()` is `NaN`, and `NaN <= now` is false, so a
 * provider that does not return the expiry columns — a narrowed `select`, a
 * schema missing one — read as a session that never expires.
 */
describe("an expiry the provider could not give us", () => {
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["an unparseable string", "not a date"],
  ])("counts as spent, not as forever: %s", async (_, value) => {
    const { result: session } = await inRequest({}, () =>
      auth.createOrUpdateSession({ email: "a@example.com", id: 1 }),
    );
    const token = session.token as string;
    provider.rows.set(token, {
      ...provider.rows.get(token)!,
      expiresAt: value as never,
      absoluteExpiresAt: value as never,
    });

    const { result } = await inRequest({ access_token: token }, () => auth.getSession(token, UA));
    expect(result).toBeNull();
  });
});

describe("the other tokens", () => {
  test("reset, verification and magic-link tokens can't be computed from the email and the time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { config } = new AuthManager({ verifyEmail: true }, provider as never);
    const user = { email: "a@example.com" } as never;
    const derived = createHash("sha256").update(`a@example.com${Date.now()}`).digest("hex");

    for (const mint of [
      () => config.generateForgotPasswordToken(user),
      () => config.generateEmailVerificationToken("a@example.com"),
      () => config.generateMagicLinkToken("a@example.com"),
    ]) {
      const [first, second] = [await mint(), await mint()];
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(first).not.toBe(derived);
      expect(second).not.toBe(first);
    }
  });
});

/**
 * `findSession` is where a provider shapes a session, and every session gemi
 * hands out has to carry that shape — not only the one `getSession` serves
 * before a renewal. #619: renewal served `updateSession`'s row and sign-in
 * served `createSessionV2`'s, both in storage order, so a client opening
 * `accounts[0]` landed somewhere else depending on how old its token was.
 */
describe("a provider that shapes the session in findSession", () => {
  const STORED = [1, 2, 3];
  const SHAPED = [3, 2, 1];

  class ShapingProvider extends MemoryProvider {
    users = [
      { id: 1, email: "a@example.com", accounts: STORED.map((id) => ({ id })) },
      { id: 2, email: "b@example.com", accounts: [] as { id: number }[] },
    ];
    async findSession(args: { token: string }) {
      const session = await super.findSession(args);
      if (session?.user) {
        session.user = { ...session.user, accounts: [...session.user.accounts].reverse() };
      }
      return session;
    }
  }

  const accountIds = (session: any) => session.user.accounts.map((a: { id: number }) => a.id);
  let extended: unknown[];

  beforeEach(() => {
    provider = new ShapingProvider();
    extended = [];
    auth = new AuthManager(
      {
        extendSession: async (user: any) => {
          extended.push(accountIds({ user }));
          return null;
        },
      },
      provider as never,
    );
  });

  async function seed(expiresInHours: number) {
    const token = `v2.${"a".repeat(64)}`;
    provider.rows.set(token, {
      token,
      userId: 1,
      userAgent: UA,
      expiresAt: new Date(Date.now() + expiresInHours * HOUR),
      absoluteExpiresAt: new Date(Date.now() + 90 * 24 * HOUR),
    });
    return token;
  }

  test("a fresh session", async () => {
    const token = await seed(auth.config.sessionExpiresInHours);
    const { result } = await inRequest({ access_token: token }, () => auth.getSession(token, UA));
    expect(accountIds(result)).toEqual(SHAPED);
    expect(extended).toEqual([SHAPED]);
  });

  test("a session renewed on this request, with the new expiry", async () => {
    const token = await seed(1);
    const updateSession = vi.spyOn(provider, "updateSession");

    const { result } = await inRequest({ access_token: token }, () => auth.getSession(token, UA));

    expect(updateSession).toHaveBeenCalledOnce();
    expect(accountIds(result)).toEqual(SHAPED);
    expect(extended).toEqual([SHAPED]);
    expect(result!.expiresAt.getTime()).toBe(provider.rows.get(token)!.expiresAt.getTime());
    expect(result!.expiresAt.getTime()).toBeGreaterThan(Date.now() + HOUR);
  });

  test("createOrUpdateSession", async () => {
    const { result } = await inRequest({}, () =>
      auth.createOrUpdateSession({ email: "a@example.com", id: 1 }),
    );
    expect(accountIds(result)).toEqual(SHAPED);
    expect(provider.rows.has(result.token)).toBe(true);
  });

  test("createOrUpdateSessionV2, and what it hands extendSession", async () => {
    const { result } = await inRequest({}, () =>
      auth.createOrUpdateSessionV2({ email: "a@example.com" }),
    );
    expect(accountIds(result)).toEqual(SHAPED);
    expect(extended).toEqual([SHAPED]);
  });

  test("authenticate, and what it hands extendSession", async () => {
    const { result, cookies } = await inRequest({}, () => auth.authenticate("a@example.com"));
    expect(accountIds(result)).toEqual(SHAPED);
    expect(extended).toEqual([SHAPED]);
    expect(accessTokenCookie(cookies)).toBe(result!.token);
  });

  test("a sign-in whose read-back finds nothing still returns the session it created", async () => {
    vi.spyOn(provider, "findSession").mockResolvedValue(null);
    const { result } = await inRequest({}, () =>
      auth.createOrUpdateSession({ email: "a@example.com", id: 1 }),
    );
    expect(result.token).toMatch(/^v2\./);
    expect(accountIds(result)).toEqual(STORED);
  });
});

/**
 * `auth.migrateLegacySession` (#621): an app that cannot sign everybody out on
 * the upgrade converts the old tokens on first use instead.
 */
describe("converting a token from before the upgrade, when the app opts in", () => {
  let asked: { session: any; token: string }[];
  let answer: boolean;

  beforeEach(() => {
    asked = [];
    answer = true;
    auth = new AuthManager(
      {
        migrateLegacySession: (session, { token }) => {
          asked.push({ session, token });
          return answer;
        },
      },
      provider as never,
    );
  });

  const newRows = () => [...provider.rows.keys()].filter((t) => t.startsWith("v2."));

  test("converts it: a v2 session for the same user, the old row gone, the new cookie out", async () => {
    // Its expiry columns were never enforced before 0.64 and are long past.
    const legacy = seedLegacy(1, "a@example.com");

    const { result, cookies } = await inRequest({ Cookie: `access_token=${legacy}` }, () =>
      auth.getSession(legacy, UA),
    );

    expect(result!.user.id).toBe(1);
    expect(result!.token).toMatch(/^v2\.[0-9a-f]{64}$/);
    expect(accessTokenCookie(cookies)).toBe(result!.token);
    expect(provider.rows.has(legacy)).toBe(false);
    expect(newRows()).toEqual([result!.token]);
    expect(provider.rows.get(result!.token)!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(asked).toHaveLength(1);
    expect(asked[0].token).toBe(legacy);
    expect(asked[0].session.user.id).toBe(1);
  });

  test("writes the cookie for a token that arrived as the header too", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    const { result, cookies } = await inRequest({ access_token: legacy }, () =>
      auth.getSession(legacy, UA),
    );
    expect(accessTokenCookie(cookies)).toBe(result!.token);
  });

  test("a row the app refuses is no session, and is left alone", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    answer = false;

    const { result, cookies } = await inRequest({ access_token: legacy }, () =>
      auth.getSession(legacy, UA),
    );

    expect(result).toBeNull();
    expect(accessTokenCookie(cookies)).toBeUndefined();
    expect(provider.rows.has(legacy)).toBe(true);
    expect(newRows()).toEqual([]);
  });

  test("a token with no row is no session, and the app is not asked", async () => {
    const { result } = await inRequest({ access_token: "f".repeat(64) }, () =>
      auth.getSession("f".repeat(64), UA),
    );
    expect(result).toBeNull();
    expect(asked).toEqual([]);
  });

  test("is single use: the old token resolves to the same session for the grace window, then to nothing", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    const { result: first } = await inRequest({ access_token: legacy }, () =>
      auth.getSession(legacy, UA),
    );

    // A request that was already in flight with the old cookie.
    const { result: late, cookies } = await inRequest({ access_token: legacy }, () =>
      auth.getSession(legacy, UA),
    );
    expect(late!.token).toBe(first!.token);
    expect(accessTokenCookie(cookies)).toBe(first!.token);
    expect(newRows()).toEqual([first!.token]);
    expect(asked).toHaveLength(1);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 21 * 60_000);
    const { result: after } = await inRequest({ access_token: legacy }, () =>
      auth.getSession(legacy, UA),
    );
    expect(after).toBeNull();
    // The converted session itself is untouched.
    const { result: current } = await inRequest({ access_token: first!.token }, () =>
      auth.getSession(first!.token as string, UA),
    );
    expect(current!.user.id).toBe(1);
  });

  test("the old token does not outlive signing out of the new session", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    const { result } = await inRequest({ access_token: legacy }, () => auth.getSession(legacy, UA));
    await provider.deleteSession({ token: result!.token as string });

    const { result: again } = await inRequest({ access_token: legacy }, () =>
      auth.getSession(legacy, UA),
    );
    expect(again).toBeNull();
    expect(newRows()).toEqual([]);
  });

  test("requests converting the same token at once all land in one session", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    // Every request reads the old row before any of them writes.
    const findSession = provider.findSession.bind(provider);
    let reads = 0;
    let release!: () => void;
    const allRead = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(provider, "findSession").mockImplementation(async (args) => {
      const found = await findSession(args);
      if (args.token === legacy && ++reads === 3) release();
      if (args.token === legacy) await allRead;
      return found;
    });

    const results = await Promise.all(
      [1, 2, 3].map(() =>
        inRequest({ access_token: legacy }, () => auth.getSession(legacy, UA)),
      ),
    );

    const tokens = new Set(results.map(({ result }) => result!.token));
    expect(tokens.size).toBe(1);
    expect(newRows()).toEqual([...tokens]);
    for (const { cookies } of results) expect(accessTokenCookie(cookies)).toBe([...tokens][0]);
    expect(provider.rows.has(legacy)).toBe(false);
  });

  test("signing out with the old token ends the converted session, within the grace window", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    // Converted early in a grace bucket, so ten minutes on is the next one.
    const start = Math.floor(Date.now() / 600_000) * 600_000 + 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const { result } = await inRequest({ access_token: legacy }, () => auth.getSession(legacy, UA));

    // The next bucket, where the old token still resolves to it.
    clock.mockReturnValue(start + 10 * 60_000);
    const { result: revoked } = await inRequest({ access_token: legacy }, () =>
      auth.revokeSession(legacy, UA),
    );

    expect(revoked!.user.id).toBe(1);
    expect(provider.rows.size).toBe(0);
    const { result: after } = await inRequest({ access_token: result!.token }, () =>
      auth.getSession(result!.token as string, UA),
    );
    expect(after).toBeNull();
  });

  test("after the grace window the old token revokes nothing: it no longer names the session", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    const { result } = await inRequest({ access_token: legacy }, () => auth.getSession(legacy, UA));

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 21 * 60_000);
    const { result: revoked } = await inRequest({}, () => auth.revokeSession(legacy, UA));

    expect(revoked).toBeNull();
    expect(newRows()).toEqual([result!.token]);
  });

  test("a sign-out that lands between the conversion's read and its write leaves no session", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    auth = new AuthManager(
      {
        migrateLegacySession: async () => {
          reach();
          await opened;
          return true;
        },
      },
      provider as never,
    );

    const converting = inRequest({ access_token: legacy }, () => auth.getSession(legacy, UA));
    await reached;
    await inRequest({}, () => auth.revokeSession(legacy, UA));
    open();
    const { result, cookies } = await converting;

    expect(result).toBeNull();
    expect(accessTokenCookie(cookies)).toBeUndefined();
    expect(provider.rows.size).toBe(0);
  });

  test("a v2 token signs out as it always did", async () => {
    const { result: session } = await inRequest({}, () =>
      auth.createOrUpdateSession({ email: "a@example.com", id: 1 }),
    );
    const findSession = vi.spyOn(provider, "findSession");
    const lock = vi.spyOn(provider, "withLegacySessionLock");

    await auth.revokeSession(session.token as string, UA);

    expect(findSession.mock.calls.map(([args]) => args.token)).toEqual([session.token]);
    expect(lock).not.toHaveBeenCalled();
    expect(provider.rows.size).toBe(0);
  });

  test("outside a request nothing is converted", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    expect(await auth.getSession(legacy, UA)).toBeNull();
    expect(provider.rows.has(legacy)).toBe(true);
    expect(asked).toEqual([]);
  });

  test("a v2 token never reaches the app's function", async () => {
    const { result: session } = await inRequest({}, () =>
      auth.createOrUpdateSession({ email: "a@example.com", id: 1 }),
    );
    const { result } = await inRequest({ access_token: session.token }, () =>
      auth.getSession(session.token as string, UA),
    );
    expect(result!.user.id).toBe(1);
    expect(asked).toEqual([]);
  });
});
