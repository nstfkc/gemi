import { beforeEach, describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { ValidationError } from "../http";
import { RateLimitExceededError } from "../http/RateLimitMiddleware";
import { RequestContext } from "../http/requestContext";
import { authConfigDefaults, passwordLimitDefaults } from "./config";
import { resetFallbackCodeLimiter, type AuthRateLimitKeyArgs } from "./oneTimeCode";

/**
 * Rate limits on the password routes (#1136): sign-in (and change password),
 * sign-up, forgot and reset password, per address and per IP, through the
 * limiter and keys the email-code routes use, partitioned by
 * `auth.rateLimitKey`.
 */

// A cheap stand-in for the hash, so the attempts below cost nothing.
const HASH = "h:correct horse";

const defaults = authConfigDefaults();
const partitions: AuthRateLimitKeyArgs[] = [];
let partition: string | undefined;

const auth = {
  config: {
    ...defaults,
    hashPassword: async (password: string) => `h:${password}`,
    verifyPassword: vi.fn(async (password: string, hash: string) => hash === `h:${password}`),
    passwordLimits: passwordLimitDefaults({
      signIn: { perEmail: [2, 900], perIp: [4, 900] },
      signUp: { perIp: [2, 3600] },
      forgot: { perEmail: [2, 900], perIp: [4, 900] },
      reset: { perIp: [2, 900] },
    }),
    rateLimitKey: (args: AuthRateLimitKeyArgs) => {
      partitions.push(args);
      return partition;
    },
    signUpRequest: HttpRequest,
    onSignIn: async () => {},
    onSignUp: async () => {},
    onForgotPassword: async () => {},
  },
  userProvider: {
    findUserByEmailAddress: vi.fn(async (email: string) =>
      email === "ada@example.com" ? { id: 1, email, password: HASH } : null,
    ),
    findPasswordResetToken: vi.fn(async () => null),
    createPasswordResetToken: vi.fn(async () => {}),
    updateUserPassword: vi.fn(async () => {}),
    deleteAllUserSessions: vi.fn(async () => {}),
    transaction: async (fn: () => Promise<unknown>) => await fn(),
    createUser: vi.fn(async (data: Record<string, unknown>) => ({ id: 2, ...data })),
  },
  createOrUpdateSession: async () => ({ token: "t", expiresAt: new Date() }),
  createOrUpdateSessionV2: async () => ({ token: "t", expiresAt: new Date() }),
  accessTokenCookieOptions: (_req: unknown, expires: Date) => ({ expires, httpOnly: true }),
  // `app(Translator)` resolves here too.
  detectLocale: () => "en",
};

vi.mock("../foundation/app", () => ({ app: () => auth }));
vi.mock("../facades", () => ({
  Auth: { user: async () => ({ id: 1, email: "ada@example.com" }) },
}));

const { AuthController } = await import("./AuthController");

type Action = "signIn" | "signInV2" | "signUp" | "forgotPassword" | "resetPassword" | "changePassword";

/** Runs an action from `ip`; "429", "400" or "ok". */
async function attempt(action: Action, body: Record<string, string>, ip = "203.0.113.1") {
  const req = new HttpRequest(
    new Request("https://app.example/api/auth/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
    {},
    "api",
  );
  return RequestContext.run(req, async () => {
    try {
      await (new AuthController() as any)[action](req);
      return "ok";
    } catch (error) {
      if (error instanceof RateLimitExceededError) return "429";
      if (error instanceof ValidationError) return "400";
      throw error;
    }
  });
}

const WRONG = { email: "ada@example.com", password: "wrong" };

beforeEach(() => {
  resetFallbackCodeLimiter();
  partitions.length = 0;
  partition = undefined;
  auth.config.verifyPassword.mockClear();
});

describe("sign-in", () => {
  for (const action of ["signIn", "signInV2"] as const) {
    test(`${action}: an address past its limit is refused`, async () => {
      expect(await attempt(action, WRONG)).toBe("400");
      expect(await attempt(action, WRONG)).toBe("400");
      expect(await attempt(action, WRONG)).toBe("429");
      // The right password too: the limit stands in front of the check.
      expect(await attempt(action, { ...WRONG, password: "correct horse" })).toBe("429");
    });
  }

  test("the address is folded, so case and padding share one budget", async () => {
    await attempt("signIn", WRONG);
    await attempt("signIn", { ...WRONG, email: "ADA@example.com" });
    expect(await attempt("signIn", { ...WRONG, email: " Ada@Example.com " })).toBe("429");
  });

  test("an IP past its limit is refused for every address", async () => {
    for (let i = 0; i < 4; i++) {
      expect(await attempt("signIn", { ...WRONG, email: `u${i}@example.com` })).toBe("400");
    }
    expect(await attempt("signIn", { ...WRONG, email: "fresh@example.com" })).toBe("429");
    // Another IP is not.
    expect(await attempt("signIn", { ...WRONG, email: "fresh@example.com" }, "203.0.113.2")).toBe("400");
  });

  test("a refusal per address still costs a hash check, one per IP does not", async () => {
    await attempt("signIn", WRONG);
    await attempt("signIn", WRONG);
    auth.config.verifyPassword.mockClear();
    expect(await attempt("signIn", WRONG)).toBe("429");
    expect(auth.config.verifyPassword).toHaveBeenCalledTimes(1);

    resetFallbackCodeLimiter();
    for (let i = 0; i < 4; i++) await attempt("signIn", { ...WRONG, email: `u${i}@example.com` });
    auth.config.verifyPassword.mockClear();
    expect(await attempt("signIn", { ...WRONG, email: "fresh@example.com" })).toBe("429");
    expect(auth.config.verifyPassword).not.toHaveBeenCalled();
  });

  test("change password spends the signed-in address's sign-in budget", async () => {
    await attempt("signIn", WRONG);
    await attempt("signIn", WRONG);
    expect(
      await attempt("changePassword", { oldPassword: "wrong", newPassword: "new password" }, "203.0.113.9"),
    ).toBe("429");
  });
});

describe("sign-up", () => {
  test("an IP past its limit is refused", async () => {
    expect(await attempt("signUp", { email: "a@example.com", password: "pw" })).toBe("ok");
    expect(await attempt("signUp", { email: "b@example.com", password: "pw" })).toBe("ok");
    expect(await attempt("signUp", { email: "c@example.com", password: "pw" })).toBe("429");
  });
});

describe("forgot password", () => {
  test("an address past its limit is refused, known or not", async () => {
    for (const email of ["ada@example.com", "nobody@example.com"]) {
      expect(await attempt("forgotPassword", { email }, `ip-${email}`)).toBe("ok");
      expect(await attempt("forgotPassword", { email }, `ip-${email}`)).toBe("ok");
      expect(await attempt("forgotPassword", { email }, `ip-${email}`)).toBe("429");
    }
  });
});

describe("reset password", () => {
  test("an IP past its limit is refused", async () => {
    const body = { password: "new password", token: "t" };
    expect(await attempt("resetPassword", body)).toBe("400");
    expect(await attempt("resetPassword", body)).toBe("400");
    expect(await attempt("resetPassword", body)).toBe("429");
  });
});

describe("rateLimitKey", () => {
  test("is asked with the password scopes", async () => {
    await attempt("signIn", WRONG);
    await attempt("signUp", { email: "a@example.com", password: "pw" });
    await attempt("forgotPassword", { email: "ada@example.com" });
    await attempt("resetPassword", { password: "x", token: "t" });
    expect(new Set(partitions.map((p) => `${p.scope}:${p.limit}`))).toEqual(
      new Set([
        "sign-in:perIp",
        "sign-in:perEmail",
        "sign-up:perIp",
        "forgot:perIp",
        "forgot:perEmail",
        "reset:perIp",
      ]),
    );
  });

  test("a partition gets a budget of its own", async () => {
    partition = "tenant-a";
    await attempt("signIn", WRONG);
    await attempt("signIn", WRONG);
    expect(await attempt("signIn", WRONG)).toBe("429");
    partition = "tenant-b";
    expect(await attempt("signIn", WRONG)).toBe("400");
  });
});

test("a limit set to false is off", async () => {
  const saved = auth.config.passwordLimits;
  auth.config.passwordLimits = passwordLimitDefaults({ signIn: { perEmail: false, perIp: false } });
  try {
    for (let i = 0; i < 60; i++) expect(await attempt("signIn", WRONG)).toBe("400");
  } finally {
    auth.config.passwordLimits = saved;
  }
});

test("the defaults", () => {
  expect(authConfigDefaults().passwordLimits).toEqual({
    signIn: { perEmail: [10, 900], perIp: [50, 900] },
    signUp: { perEmail: false, perIp: [10, 3600] },
    forgot: { perEmail: [5, 900], perIp: [20, 900] },
    reset: { perEmail: false, perIp: [20, 900] },
  });
});
