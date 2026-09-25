import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AuthManager } from "./AuthManager";
import { replacedToken } from "./sessionToken";
import { Application } from "../foundation/Application";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { AuthenticationError } from "../http/errors";

/**
 * Sessions against an in-memory provider: the token is minted, not derived;
 * a sign-in never lands in somebody else's row; expiry is enforced; and a
 * token from before all that is moved over without signing anybody out.
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
  async updateSession(args: { token: string; expiresAt: Date; absoluteExpiresAt?: Date }) {
    const row = this.rows.get(args.token)!;
    row.expiresAt = args.expiresAt;
    if (args.absoluteExpiresAt) row.absoluteExpiresAt = args.absoluteExpiresAt;
    return this.withUser(row);
  }
  async deleteSession({ token }: { token: string }) {
    this.rows.delete(token);
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

describe("a token from before the upgrade", () => {
  test("sent as the cookie, is exchanged for a new one without signing anybody out", async () => {
    const legacy = seedLegacy(1, "a@example.com");

    const { result, cookies } = await inRequest(
      { Cookie: `access_token=${legacy}` },
      async (req) => {
        const session = await auth.getSession(legacy, UA);
        return { session, replaced: replacedToken(req.rawRequest) };
      },
    );

    const next = accessTokenCookie(cookies)!;
    expect(result.session!.user.id).toBe(1);
    expect(next).toMatch(/^v2\./);
    expect(result.replaced).toBe(next);
    expect(provider.rows.get(next)!.userId).toBe(1);
    expect(provider.rows.get(next)!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("keeps working through its grace period, without being exchanged twice", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    const cookie = { Cookie: `access_token=${legacy}` };

    await inRequest(cookie, () => auth.getSession(legacy, UA));
    const { result, cookies } = await inRequest(cookie, () => auth.getSession(legacy, UA));

    expect(result!.user.id).toBe(1);
    expect(accessTokenCookie(cookies)).toBeUndefined();
    expect(provider.rows.size).toBe(2);
  });

  test("stops working when its grace period is over", async () => {
    const legacy = seedLegacy(1, "a@example.com");
    const cookie = { Cookie: `access_token=${legacy}` };

    await inRequest(cookie, () => auth.getSession(legacy, UA));
    provider.rows.get(legacy)!.absoluteExpiresAt = new Date(Date.now() - 1000);

    const { result } = await inRequest(cookie, () => auth.getSession(legacy, UA));
    expect(result).toBeNull();
    expect(provider.rows.has(legacy)).toBe(false);
  });

  test("sent in the header, is left alone, since that client may not read a new one", async () => {
    const legacy = seedLegacy(1, "a@example.com");

    const { result, cookies } = await inRequest({ access_token: legacy }, () =>
      auth.getSession(legacy, UA),
    );

    expect(result!.user.id).toBe(1);
    expect(accessTokenCookie(cookies)).toBeUndefined();
    expect(provider.rows.size).toBe(1);
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
