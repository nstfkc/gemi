import { beforeEach, describe, expect, test, vi } from "vitest";
import { ValidationError } from "../http";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { authConfigDefaults } from "./config";
import { SignUpRequest } from "./requests";

/**
 * Auth routes check the runtime type of what they read from a request before
 * any of it reaches a query.
 *
 * A JSON body can put an object or an array where a string was expected, and
 * the ORM reads an object in a `where` as a filter rather than a value to match.
 * So each route answers a value of the wrong type exactly as it answers a
 * wrong one, and never hands it to the user provider.
 */

/** Wrong-typed values a JSON body can carry, filter-shaped ones first. */
const PAYLOADS: Array<[string, unknown]> = [
  ["an empty object", {}],
  ["a not filter", { not: "000000" }],
  ["a nested operator", { not: { equals: "x" } }],
  ["an in filter", { in: ["000000", "123456"] }],
  ["an array", ["123456"]],
  ["null", null],
  ["a number", 123456],
  ["a boolean", true],
];

const defaults = authConfigDefaults();

const userProvider = {
  findUserMagicLinkToken: vi.fn(async () => null),
  findUserByVerificationToken: vi.fn(async () => null),
  findPasswordResetToken: vi.fn(async () => null),
  findUserByEmailAddress: vi.fn(async () => null),
  findInvitation: vi.fn(async () => null),
  deleteMagicLinkToken: vi.fn(async () => {}),
  verifyUser: vi.fn(async () => {}),
  updateUserPassword: vi.fn(async () => {}),
  deleteAllUserSessions: vi.fn(async () => {}),
};

const auth = {
  config: {
    ...defaults,
    signUpRequest: SignUpRequest,
    verifyPassword: vi.fn(defaults.verifyPassword),
    hashPassword: vi.fn(async () => "hash"),
    onSignIn: async () => {},
  },
  userProvider,
  createMagicLinkToken: vi.fn(async () => ({})),
  verifyOneTimeCode: vi.fn(async (..._args: unknown[]) => ({ status: "invalid" as const })),
  verifyMagicLinkToken: vi.fn(async (..._args: unknown[]) => false),
  createOrUpdateSession: async () => ({ token: "t", expiresAt: new Date() }),
  createOrUpdateSessionV2: async () => ({ token: "t", expiresAt: new Date() }),
  accessTokenCookieOptions: (_req: unknown, expires: Date) => ({
    expires,
    httpOnly: true,
    secure: false,
    domain: undefined,
  }),
};

vi.mock("../foundation/app", () => ({ app: () => auth }));
// The verify limits are covered in oneTimeCode.test.ts; here every request
// reaches the input checks.
vi.mock("./oneTimeCode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oneTimeCode")>()),
  enforceCodeRateLimits: async () => {},
}));
vi.mock("../facades", () => ({
  Auth: { user: async () => ({ id: 1, email: "victim@example.com" }) },
}));

const { AuthController } = await import("./AuthController");

type Action =
  | "signInWithPin"
  | "signInWithPinV2"
  | "signIn"
  | "signInV2"
  | "signUp"
  | "verifyEmail"
  | "forgotPassword"
  | "resetPassword"
  | "changePassword"
  | "createMagicLinkToken"
  | "signInWithMagicLink"
  | "verifyEmailCode";

/** Runs an action on a JSON body; resolves to its result or its validation errors. */
async function run(
  action: Action,
  body: Record<string, unknown>,
  url = "https://app.example/api/auth",
) {
  const req = new HttpRequest(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
    "api",
  );
  return RequestContext.run(req, async () => {
    try {
      // No argument: each action builds its own request class (and schema), as
      // the router has it do.
      return { ok: true, result: await (new AuthController() as any)[action]() };
    } catch (error) {
      // Anything but a validation error is a 500, which is a failure here too.
      if (!(error instanceof ValidationError)) throw error;
      return { ok: false, errors: error.errors };
    }
  });
}

/** Every user-provider argument recorded, flattened to its leaf values. */
function leavesPassedToProvider() {
  const leaves: unknown[] = [];
  const walk = (value: unknown) => {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      for (const child of Object.values(value)) walk(child);
    } else {
      leaves.push(value);
    }
  };
  for (const fn of Object.values(userProvider)) {
    for (const call of fn.mock.calls) {
      for (const arg of call) {
        if (Array.isArray(arg) || (arg && typeof arg === "object" && Object.getPrototypeOf(arg) === Object.prototype && Object.keys(arg).length === 0)) {
          leaves.push(arg);
        } else {
          walk(arg);
        }
      }
    }
  }
  return leaves;
}

/** Nothing but strings, numbers and booleans (or nothing) reached the provider. */
function expectOnlyPlainValuesReachedProvider() {
  for (const leaf of leavesPassedToProvider()) {
    expect(["string", "number", "boolean", "undefined"]).toContain(typeof leaf);
  }
}

const INVALID_PIN = { ok: false, errors: { pin: ["Invalid pin"] } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(["signInWithPin", "signInWithPinV2"] as const)("%s", (action) => {
  test.each(PAYLOADS)("a pin that is %s is a wrong pin", async (_, pin) => {
    expect(await run(action, { email: "victim@example.com", pin })).toEqual(INVALID_PIN);
    expect(auth.verifyOneTimeCode).not.toHaveBeenCalled();
  });

  test.each(PAYLOADS)("an email that is %s is a wrong pin", async (_, email) => {
    expect(await run(action, { email, pin: "123456" })).toEqual(INVALID_PIN);
    expect(auth.verifyOneTimeCode).not.toHaveBeenCalled();
  });

  test.each(["", "1".repeat(257)])("a pin of %j is a wrong pin, with no lookup", async (pin) => {
    expect(await run(action, { email: "victim@example.com", pin })).toEqual(INVALID_PIN);
    expect(auth.verifyOneTimeCode).not.toHaveBeenCalled();
  });

  test("a missing pin is a wrong pin", async () => {
    expect(await run(action, { email: "victim@example.com" })).toEqual(INVALID_PIN);
    expect(auth.verifyOneTimeCode).not.toHaveBeenCalled();
  });

  // The code's format is not checked: `emailCode.length` and `generateCode`
  // decide it, and the comparison is of keyed hashes (#708).
  test.each(["012345", "1234", "12345678", "AB12-cd34", "1".repeat(256)])(
    "a string pin of %j is checked as a string",
    async (pin) => {
      expect(await run(action, { email: " Victim@Example.com ", pin })).toEqual(INVALID_PIN);
      expect(auth.verifyOneTimeCode).toHaveBeenCalledWith("victim@example.com", pin);
    },
  );

  test("a matching code of another length signs in", async () => {
    auth.verifyOneTimeCode.mockResolvedValueOnce({ status: "ok", row: { id: 1 } } as any);
    const result = await run(action, { email: "victim@example.com", pin: "12345678" });
    expect(result.ok).toBe(true);
    expect(userProvider.verifyUser).toHaveBeenCalledWith("victim@example.com");
  });
});

describe("verifyEmailCode", () => {
  const INVALID_CODE = { ok: false, errors: { code: ["invalid_code"] } };
  beforeEach(() => {
    auth.config.emailCode = { ...defaults.emailCode, enabled: true };
  });

  test.each(PAYLOADS)("a code that is %s is an invalid code", async (_, code) => {
    expect(await run("verifyEmailCode", { email: "victim@example.com", code })).toEqual(
      INVALID_CODE,
    );
    expect(auth.verifyOneTimeCode).not.toHaveBeenCalled();
  });

  test.each(["12345678", "AB12-cd34"])("a string code of %j is checked", async (code) => {
    expect(await run("verifyEmailCode", { email: "victim@example.com", code })).toEqual(
      INVALID_CODE,
    );
    expect(auth.verifyOneTimeCode).toHaveBeenCalledWith("victim@example.com", code, {
      claim: false,
    });
  });
});

describe("signInWithMagicLink", () => {
  const link = (query: string) => `https://app.example/auth/sign-in/magic-link?${query}`;

  test.each([
    ["no token", "email=victim%40example.com"],
    ["an empty token", "email=victim%40example.com&token="],
    ["no email", "token=abc"],
    ["neither", ""],
  ])("%s is an invalid token, with no lookup", async (_, query) => {
    expect(await run("signInWithMagicLink", {}, link(query))).toEqual({
      ok: true,
      result: { error: "Invalid token" },
    });
    expect(auth.verifyMagicLinkToken).not.toHaveBeenCalled();
  });

  test("a repeated token is an invalid token, with no lookup", async () => {
    expect(
      await run("signInWithMagicLink", {}, link("email=victim%40example.com&token=a&token=b")),
    ).toEqual({ ok: true, result: { error: "Invalid token" } });
    expect(auth.verifyMagicLinkToken).not.toHaveBeenCalled();
  });

  test("a token and email are checked as strings", async () => {
    expect(
      await run("signInWithMagicLink", {}, link("email=Victim%40example.com&token=abc")),
    ).toEqual({ ok: true, result: { error: "Invalid token" } });
    expect(auth.verifyMagicLinkToken).toHaveBeenCalledWith("victim@example.com", "abc");
  });
});

describe("verifyEmail", () => {
  test.each(PAYLOADS)("a token that is %s verifies nobody", async (_, token) => {
    expect(await run("verifyEmail", { token })).toEqual({ ok: true, result: { email: null } });
    expect(userProvider.findUserByVerificationToken).not.toHaveBeenCalled();
    expect(userProvider.verifyUser).not.toHaveBeenCalled();
  });
});

describe("resetPassword", () => {
  test.each(PAYLOADS)("a token that is %s is an invalid token", async (_, token) => {
    expect(await run("resetPassword", { token, password: "Str0ng-password" })).toEqual({
      ok: false,
      errors: { token: ["Invalid token"] },
    });
    expect(userProvider.findPasswordResetToken).not.toHaveBeenCalled();
    expect(userProvider.updateUserPassword).not.toHaveBeenCalled();
  });
});

describe.each(["signIn", "signInV2"] as const)("%s", (action) => {
  test.each(PAYLOADS)("an email that is %s is refused", async (_, email) => {
    const outcome = await run(action, { email, password: "x" });
    expect(outcome.ok).toBe(false);
    expectOnlyPlainValuesReachedProvider();
  });

  test.each(PAYLOADS)("a password that is %s is invalid credentials", async (_, password) => {
    const outcome = await run(action, { email: "victim@example.com", password });
    expect(outcome.ok).toBe(false);
    expect(auth.config.verifyPassword).not.toHaveBeenCalled();
    expectOnlyPlainValuesReachedProvider();
  });
});

describe("signUp", () => {
  const valid = { name: "Mallory", email: "victim@example.com", password: "Str0ng-password" };

  test.each(PAYLOADS)("an email that is %s is refused", async (_, email) => {
    expect((await run("signUp", { ...valid, email })).ok).toBe(false);
    expect(userProvider.findUserByEmailAddress).not.toHaveBeenCalled();
  });

  test.each(PAYLOADS.filter(([, v]) => v !== null))(
    "an invitationId that is %s is refused",
    async (_, invitationId) => {
      expect(await run("signUp", { ...valid, invitationId })).toEqual({
        ok: false,
        errors: { invitationId: ["Invalid invitation"] },
      });
      expect(userProvider.findInvitation).not.toHaveBeenCalled();
    },
  );
});

describe("forgotPassword", () => {
  test.each(PAYLOADS)("an email that is %s is refused", async (_, email) => {
    expect((await run("forgotPassword", { email })).ok).toBe(false);
    expect(userProvider.findUserByEmailAddress).not.toHaveBeenCalled();
  });
});

describe("createMagicLinkToken", () => {
  test.each(PAYLOADS)("an email that is %s creates nothing", async (_, email) => {
    expect(await run("createMagicLinkToken", { email })).toEqual({
      ok: true,
      result: { email: null },
    });
    expect(auth.createMagicLinkToken).not.toHaveBeenCalled();
  });
});

describe("changePassword", () => {
  test.each(PAYLOADS)("an old password that is %s is incorrect", async (_, oldPassword) => {
    expect(await run("changePassword", { oldPassword, newPassword: "Str0ng-password" })).toEqual({
      ok: false,
      errors: { oldPassword: ["Incorrect password"] },
    });
    expect(userProvider.updateUserPassword).not.toHaveBeenCalled();
  });

  test.each(PAYLOADS)("a new password that is %s is refused", async (_, newPassword) => {
    expect((await run("changePassword", { oldPassword: "x", newPassword })).ok).toBe(false);
    expect(auth.config.hashPassword).not.toHaveBeenCalled();
    expect(userProvider.updateUserPassword).not.toHaveBeenCalled();
  });
});
