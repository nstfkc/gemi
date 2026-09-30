import { beforeEach, describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { ValidationError } from "../http";
import { RequestContext } from "../http/requestContext";
import { authConfigDefaults, verifyPasswordHash } from "./config";

/**
 * Password checks against an account that has no password (#276).
 *
 * A user created through OAuth has `password = NULL`. The default
 * `verifyPassword` handed that to `Bun.password.verify`, which throws
 * `UnsupportedAlgorithm`, so signing in to such an account with a password was
 * a 500 — where an unknown address or a wrong password is a clean
 * `invalid_credentials`, which made the 500 an enumeration signal too.
 */

const HASH = await Bun.password.hash("correct horse");

const USERS: Record<string, { id: number; email: string; password: string | null }> = {
  "normal@example.com": { id: 1, email: "normal@example.com", password: HASH },
  "oauth@example.com": { id: 2, email: "oauth@example.com", password: null },
  "empty@example.com": { id: 3, email: "empty@example.com", password: "" },
  "corrupt@example.com": { id: 4, email: "corrupt@example.com", password: "not-a-hash" },
};

const defaults = authConfigDefaults();
const auth = {
  config: {
    ...defaults,
    verifyPassword: vi.fn(defaults.verifyPassword),
    onSignIn: async () => {},
  },
  userProvider: {
    findUserByEmailAddress: vi.fn(async (email: string) =>
      USERS[email] ? { ...USERS[email] } : null,
    ),
    updateUserPassword: vi.fn(async () => {}),
    deleteAllUserSessions: vi.fn(async () => {}),
  },
  createOrUpdateSession: async () => ({ token: "t", expiresAt: new Date() }),
  createOrUpdateSessionV2: async () => ({ token: "t", expiresAt: new Date() }),
  accessTokenCookieOptions: (_req: unknown, expires: Date) => ({
    expires,
    httpOnly: true,
    secure: false,
    domain: undefined,
  }),
};

let signedInAs = "normal@example.com";

vi.mock("../foundation/app", () => ({ app: () => auth }));
vi.mock("../facades", () => ({
  Auth: { user: async () => ({ ...USERS[signedInAs] }) },
}));

const { AuthController } = await import("./AuthController");

function request(body: Record<string, string>) {
  return new HttpRequest(
    new Request("https://app.example/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
    "api",
  );
}

/** Runs a controller action; resolves to its result, or the errors it threw. */
async function run(
  action: "signIn" | "signInV2" | "changePassword",
  body: Record<string, string>,
): Promise<{ ok: true; result: unknown } | { ok: false; errors: Record<string, string[]> }> {
  const req = request(body);
  return RequestContext.run(req, async () => {
    try {
      return { ok: true, result: await new AuthController()[action](req as never) };
    } catch (error) {
      // Anything but a validation error is the 500 this is about.
      if (!(error instanceof ValidationError)) throw error;
      return { ok: false, errors: error.errors };
    }
  });
}

const INVALID = { ok: false, errors: { invalid_credentials: ["Invalid credentials"] } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(["signIn", "signInV2"] as const)("%s", (action) => {
  test("an OAuth-only user signing in with a password gets invalid_credentials", async () => {
    expect(await run(action, { email: "oauth@example.com", password: "anything" })).toEqual(
      INVALID,
    );
  });

  test("a user with an empty stored hash gets invalid_credentials", async () => {
    expect(await run(action, { email: "empty@example.com", password: "" })).toEqual(INVALID);
    expect(await run(action, { email: "empty@example.com", password: "x" })).toEqual(INVALID);
  });

  test("a user whose stored hash is not a hash gets invalid_credentials", async () => {
    expect(await run(action, { email: "corrupt@example.com", password: "x" })).toEqual(INVALID);
  });

  test("a normal user signs in with the right password", async () => {
    const outcome = await run(action, { email: "normal@example.com", password: "correct horse" });

    expect(outcome).toEqual({ ok: true, result: { id: 1, email: "normal@example.com" } });
  });

  test("a normal user with the wrong password gets invalid_credentials", async () => {
    expect(await run(action, { email: "normal@example.com", password: "wrong" })).toEqual(INVALID);
  });

  test("an unknown address gets invalid_credentials", async () => {
    expect(await run(action, { email: "nobody@example.com", password: "x" })).toEqual(INVALID);
  });

  /**
   * The timing half of it: a missing hash is not a shortcut. A hash is
   * verified for every one of these, so the response takes as long as a
   * wrong password's, and `verifyPassword` is never handed a missing one — a
   * custom implementation typed `(password, hash: string)` stays safe.
   */
  test("verifies a real hash whether or not there is a password to check", async () => {
    for (const email of ["oauth@example.com", "empty@example.com", "nobody@example.com"]) {
      auth.config.verifyPassword.mockClear();
      await run(action, { email, password: "x" });

      expect(auth.config.verifyPassword).toHaveBeenCalledTimes(1);
      const [, hash] = auth.config.verifyPassword.mock.calls[0];
      expect(hash).toMatch(/^\$argon2id\$/);
    }
  });
});

describe("changePassword", () => {
  test("an OAuth-only user gets a validation error on oldPassword, not a 500", async () => {
    signedInAs = "oauth@example.com";

    expect(
      await run("changePassword", { oldPassword: "anything", newPassword: "new password" }),
    ).toEqual({ ok: false, errors: { oldPassword: ["Incorrect password"] } });
    expect(auth.userProvider.updateUserPassword).not.toHaveBeenCalled();
  });

  test("a normal user changes it with the right old password", async () => {
    signedInAs = "normal@example.com";

    expect(
      await run("changePassword", { oldPassword: "correct horse", newPassword: "new password" }),
    ).toEqual({ ok: true, result: {} });
    expect(auth.userProvider.updateUserPassword).toHaveBeenCalledTimes(1);
  });

  test("a normal user with the wrong old password gets a validation error", async () => {
    signedInAs = "normal@example.com";

    expect(
      await run("changePassword", { oldPassword: "wrong", newPassword: "new password" }),
    ).toEqual({ ok: false, errors: { oldPassword: ["Incorrect password"] } });
  });
});

describe("the default verifyPassword", () => {
  test("is false, not a throw, for a hash it cannot check", async () => {
    await expect(verifyPasswordHash("x", null)).resolves.toBe(false);
    await expect(verifyPasswordHash("x", undefined)).resolves.toBe(false);
    await expect(verifyPasswordHash("x", "")).resolves.toBe(false);
    await expect(verifyPasswordHash("", "")).resolves.toBe(false);
    await expect(verifyPasswordHash("x", "not-a-hash")).resolves.toBe(false);
  });

  test("still checks a real hash", async () => {
    await expect(verifyPasswordHash("correct horse", HASH)).resolves.toBe(true);
    await expect(verifyPasswordHash("wrong", HASH)).resolves.toBe(false);
  });
});
