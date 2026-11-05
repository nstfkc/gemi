import { beforeEach, describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { ValidationError } from "../http";
import { RequestContext } from "../http/requestContext";
import { authConfigDefaults } from "./config";

/**
 * `auth.verifyEmail` as a function of the request (#1135): password sign-in
 * and forgot-password look the user up with the answer for that request, and
 * a sign-up on a request where it is off stores no verification token.
 */

const VERIFYING_HOST = "app.example.com";

const defaults = authConfigDefaults();
const createUser = vi.fn(async (data: Record<string, unknown>) => ({ id: 1, ...data }));
const onSignUp = vi.fn(async () => {});
const auth = {
  config: {
    ...defaults,
    verifyEmail: ({ req }: { req: HttpRequest<any, any> }) =>
      new URL(req.rawRequest.url).host === VERIFYING_HOST,
    signUpRequest: HttpRequest,
    onSignIn: async () => {},
    onSignUp,
    onForgotPassword: async () => {},
  },
  userProvider: {
    findUserByEmailAddress: vi.fn(async () => null),
    transaction: async (fn: () => Promise<unknown>) => await fn(),
    createUser,
  },
  // `app(Translator)` resolves here too.
  detectLocale: () => "en",
};

vi.mock("../foundation/app", () => ({ app: () => auth }));

const { AuthController } = await import("./AuthController");

function request(host: string, path: string, body: Record<string, string>) {
  return new HttpRequest(
    new Request(`https://${host}/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
    "api",
  );
}

async function run(host: string, action: "signIn" | "forgotPassword" | "signUp", body: Record<string, string>) {
  const req = request(host, `/${action}`, body);
  return RequestContext.run(req, async () => {
    try {
      return await (new AuthController() as any)[action](req);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return error;
    }
  });
}

beforeEach(() => {
  auth.userProvider.findUserByEmailAddress.mockClear();
  createUser.mockClear();
  onSignUp.mockClear();
});

describe("password sign-in", () => {
  test.each([
    [VERIFYING_HOST, true],
    ["tenant.example.com", false],
  ])("on %s looks the user up with verifyEmail %j", async (host, verify) => {
    await run(host, "signIn", { email: "ada@example.com", password: "pw" });
    expect(auth.userProvider.findUserByEmailAddress).toHaveBeenCalledWith("ada@example.com", verify);
  });
});

describe("forgot password", () => {
  test.each([
    [VERIFYING_HOST, true],
    ["tenant.example.com", false],
  ])("on %s looks the user up with verifyEmail %j", async (host, verify) => {
    await run(host, "forgotPassword", { email: "ada@example.com" });
    expect(auth.userProvider.findUserByEmailAddress).toHaveBeenCalledWith("ada@example.com", verify);
  });
});

describe("sign-up", () => {
  test("where it is on, a verification token is stored and handed to onSignUp", async () => {
    await run(VERIFYING_HOST, "signUp", { email: "ada@example.com", password: "pw" });
    const token = createUser.mock.calls[0]![0].verificationToken;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((onSignUp.mock.calls[0] as unknown[])[1]).toBe(token);
  });

  test("where it is off, no token is stored and onSignUp is handed \"\"", async () => {
    await run("tenant.example.com", "signUp", { email: "ada@example.com", password: "pw" });
    expect(createUser.mock.calls[0]![0].verificationToken).toBe("");
    expect((onSignUp.mock.calls[0] as unknown[])[1]).toBe("");
  });
});

describe("the magic-link page", () => {
  test("answers 404 on a request where both magicLink and emailCode.enabled are off", async () => {
    const config = auth.config as Record<string, any>;
    const saved = { magicLink: config.magicLink, emailCode: config.emailCode };
    config.magicLink = ({ req }: { req: HttpRequest<any, any> }) =>
      new URL(req.rawRequest.url).host === VERIFYING_HOST;
    config.emailCode = { ...config.emailCode, enabled: false };
    try {
      const req = new HttpRequest(
        new Request("https://tenant.example.com/auth/sign-in/magic-link?email=a&token=b"),
        {},
        "view",
      );
      const error = await RequestContext.run(req, async () =>
        new AuthController().signInWithMagicLink(req).then(
          () => null,
          (caught) => caught,
        ),
      );
      expect(error?.payload?.view?.status).toBe(404);
    } finally {
      Object.assign(config, saved);
    }
  });
});
