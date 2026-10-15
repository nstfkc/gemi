import { beforeEach, describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { authConfigDefaults, type UserCreatedContext } from "./config";
import { SignUpRequest } from "./requests";

/**
 * `onUserCreated` is handed how the user was created and what the creating
 * request carried, minus its credentials, so an application can write a field
 * its sign-up form adds (marketing consent, say) in the same transaction as the
 * user.
 */

const defaults = authConfigDefaults();
const userCreated: Array<[unknown, UserCreatedContext]> = [];

const userProvider = {
  findUserByEmailAddress: vi.fn(async () => null),
  findInvitation: vi.fn(async () => ({ organizationId: 7, role: 1 })),
  deleteInvitationById: vi.fn(async () => {}),
  createAccount: vi.fn(async () => {}),
  claimMagicLinkToken: vi.fn(async () => true),
  transaction: async (fn: () => Promise<unknown>) => await fn(),
  createUser: vi.fn(async (args: Record<string, unknown>) => ({ id: 99, ...args })),
};

const auth = {
  config: {
    ...defaults,
    signUpRequest: SignUpRequest,
    hashPassword: vi.fn(async () => "hash"),
    generateEmailVerificationToken: vi.fn(async () => "verify-token"),
    emailCode: { ...defaults.emailCode, enabled: true, createUser: true },
    onSignIn: async () => {},
    onSignUp: async () => {},
    onUserCreated: async (user: unknown, context: UserCreatedContext) => {
      userCreated.push([user, context]);
    },
  },
  userProvider,
  verifyOneTimeCode: vi.fn(async () => ({ status: "ok" as const, row: { id: 1 } })),
  createOrUpdateSessionV2: async () => ({ token: "t", expiresAt: new Date(Date.now() + 60_000) }),
  accessTokenCookieOptions: (_req: unknown, expires: Date) => ({ expires, httpOnly: true }),
  detectLocale: () => "en-US",
};

vi.mock("../foundation/app", () => ({ app: () => auth }));
vi.mock("./oneTimeCode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oneTimeCode")>()),
  enforceCodeRateLimits: async () => {},
}));

const { AuthController } = await import("./AuthController");

async function run(action: "signUp" | "verifyEmailCode", body: Record<string, unknown>) {
  const req = new HttpRequest(
    new Request("https://app.example/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
    "api",
  );
  // No argument: each action builds its own request class, as the router has it do.
  return RequestContext.run(req, () => (new AuthController() as any)[action]());
}

beforeEach(() => {
  vi.clearAllMocks();
  userCreated.length = 0;
});

describe("onUserCreated", () => {
  test("a sign-up hands over the form's other fields, never the password", async () => {
    await run("signUp", {
      email: "ada@example.com",
      name: "Ada",
      password: "correct horse",
      marketingEmails: "on",
    });

    expect(userCreated).toHaveLength(1);
    const [user, context] = userCreated[0]!;
    expect(user).toMatchObject({ id: 99, email: "ada@example.com" });
    expect(context.method).toBe("password");
    expect(context.input).toMatchObject({ email: "ada@example.com", marketingEmails: "on" });
    expect(context.input).not.toHaveProperty("password");
  });

  test("an invited sign-up hands over the same", async () => {
    await run("signUp", {
      email: "ada@example.com",
      name: "Ada",
      password: "correct horse",
      invitationId: "inv-1",
      marketingEmails: "on",
    });

    const [, context] = userCreated[0]!;
    expect(context.method).toBe("password");
    expect(context.input).toMatchObject({ marketingEmails: "on", invitationId: "inv-1" });
    expect(context.input).not.toHaveProperty("password");
  });

  test("a first email-code sign-in hands over the body, never the code", async () => {
    await run("verifyEmailCode", {
      email: "ada@example.com",
      code: "123456",
      name: "Ada",
      marketingEmails: true,
    });

    expect(userCreated).toHaveLength(1);
    const [, context] = userCreated[0]!;
    expect(context.method).toBe("email-code");
    expect(context.input).toEqual({ email: "ada@example.com", name: "Ada", marketingEmails: true });
  });
});
