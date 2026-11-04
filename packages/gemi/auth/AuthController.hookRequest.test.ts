import { beforeEach, describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { authConfigDefaults } from "./config";

/**
 * #1126: every auth lifecycle hook is handed the request that triggered it, so
 * a hook can read the host, a header or a cookie (which tenant a reset mail or
 * a sign-in belongs to) without reaching for ambient state. The positional
 * hooks get it as a trailing `{ req }`, `onMagicLinkCreated` as a field.
 */

const HASH = await Bun.password.hash("correct horse");
const USER = { id: 1, email: "ada@example.com", password: HASH };

const defaults = authConfigDefaults();
const hooks = {
  onSignIn: vi.fn(async () => {}),
  onForgotPassword: vi.fn(async () => {}),
  onResetPassword: vi.fn(async () => {}),
  onMagicLinkCreated: vi.fn(async () => {}),
};

const auth = {
  config: { ...defaults, ...hooks },
  userProvider: {
    findUserByEmailAddress: vi.fn(async () => ({ ...USER })),
    createPasswordResetToken: vi.fn(async () => {}),
    findPasswordResetToken: vi.fn(async () => ({
      createdAt: new Date(),
      user: { email: USER.email },
    })),
    deletePasswordResetToken: vi.fn(async () => {}),
    updateUserPassword: vi.fn(async () => {}),
    deleteAllUserSessions: vi.fn(async () => {}),
  },
  createMagicLinkToken: vi.fn(async () => ({ user: { ...USER }, pin: "123456", token: "tok" })),
  createOrUpdateSession: async () => ({ token: "t", expiresAt: new Date() }),
  createOrUpdateSessionV2: async () => ({ token: "t", expiresAt: new Date() }),
  accessTokenCookieOptions: (_req: unknown, expires: Date) => ({ expires, httpOnly: true }),
};

vi.mock("../foundation/app", () => ({ app: () => auth }));
vi.mock("./oneTimeCode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oneTimeCode")>()),
  enforceCodeRateLimits: async () => {},
}));

const { AuthController } = await import("./AuthController");

function request(path: string, body: Record<string, string>) {
  return new HttpRequest(
    new Request(`https://tenant-a.example${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tenant": "a" },
      body: JSON.stringify(body),
    }),
    {},
    "api",
  );
}

async function run(
  action: "signIn" | "forgotPassword" | "resetPassword" | "createMagicLinkToken",
  path: string,
  body: Record<string, string>,
) {
  const req = request(path, body);
  await RequestContext.run(req, () => (new AuthController() as any)[action](req));
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lifecycle hooks get the request (#1126)", () => {
  test("onSignIn: (user, search, { req })", async () => {
    const req = await run("signIn", "/api/auth/sign-in", {
      email: USER.email,
      password: "correct horse",
    });
    expect(hooks.onSignIn).toHaveBeenCalledTimes(1);
    const args = hooks.onSignIn.mock.calls[0] as unknown[];
    expect(args).toHaveLength(3);
    expect(args[2]).toEqual({ req });
  });

  test("onForgotPassword: (user, token, { req })", async () => {
    const req = await run("forgotPassword", "/api/auth/forgot-password", { email: USER.email });
    const args = hooks.onForgotPassword.mock.calls[0] as unknown[];
    expect(args[1]).toEqual(expect.any(String));
    expect(args[2]).toEqual({ req });
    expect((args[2] as { req: HttpRequest }).req.headers.get("x-tenant")).toBe("a");
  });

  test("onResetPassword: (user, { req })", async () => {
    const req = await run("resetPassword", "/api/auth/reset-password", {
      token: "reset-token",
      password: "a new long password",
    });
    const args = hooks.onResetPassword.mock.calls[0] as unknown[];
    expect(args[0]).toMatchObject({ id: 1 });
    expect(args[1]).toEqual({ req });
  });

  test("onMagicLinkCreated: (user, { email, token, pin, req })", async () => {
    const req = await run("createMagicLinkToken", "/api/auth/magic-link", { email: USER.email });
    const args = hooks.onMagicLinkCreated.mock.calls[0] as unknown[];
    expect(args[1]).toEqual({ email: USER.email, pin: "123456", token: "tok", req });
  });
});
