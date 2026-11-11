import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { Translator } from "../i18n/Translator";
import { AuthManager } from "./AuthManager";
import { checkFixedSignInCode, matchesFixedSignInCode } from "./fixedCode";
import { authConfigDefaults, emailCodeDefaults, type EmailCodeConfig } from "./config";
import { resetFallbackCodeLimiter } from "./oneTimeCode";
import type { MagicLinkTokenRow } from "./types";

/**
 * A fixed sign-in code for development and tests (#1190):
 * `auth.emailCode.fixedCode` or `AUTH_FIXED_CODE` is accepted by
 * `/auth/email-code/verify` for any address, next to the issued code, and is
 * refused in production.
 */

const EMAIL = "ada@example.com";

class MemoryProvider {
  rows: MagicLinkTokenRow[] = [];
  users: Array<{ id: number; email: string; name: string }> = [];
  nextId = 1;

  async createMagicLinkToken(args: { email: string; token: string; pin: string }) {
    const row = { id: this.nextId++, ...args, createdAt: new Date() };
    this.rows.push(row);
    return row;
  }
  async findMagicLinkTokenByEmail(email: string) {
    return this.rows.filter((row) => row.email === email).sort((a, b) => b.id - a.id)[0] ?? null;
  }
  async claimMagicLinkToken(id: number) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== id);
    return this.rows.length < before;
  }
  async deleteMagicLinkToken(email: string) {
    this.rows = this.rows.filter((row) => row.email !== email);
  }
  async findUserByEmailAddress(email: string) {
    return this.users.find((user) => user.email === email) ?? null;
  }
  async verifyUser() {}
  async transaction<T>(fn: () => Promise<T>) {
    return await fn();
  }
  async createUser(args: { email: string; name: string }) {
    const user = { id: 100 + this.users.length, email: args.email, name: args.name };
    this.users.push(user);
    return user;
  }
}

let provider: MemoryProvider;
let auth: AuthManager;

vi.mock("../foundation/app", () => ({
  app: (token?: unknown) =>
    token === undefined
      ? { bound: () => false }
      : token === Translator
        ? { detectLocale: () => "en-US" }
        : auth,
}));

const { AuthController } = await import("./AuthController");

function manager(emailCode: EmailCodeConfig = {}) {
  const manager = new AuthManager(
    { emailCode: { enabled: true, createUser: true, ...emailCode } },
    provider as never,
  );
  manager.createOrUpdateSessionV2 = (async () => ({
    token: "session-token",
    expiresAt: new Date(Date.now() + 60_000),
  })) as never;
  return manager;
}

async function verify(body: Record<string, unknown>) {
  const req = new HttpRequest(
    new Request("https://app.example/api/auth/email-code/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
    "api",
  );
  return RequestContext.run(req, () => new AuthController().verifyEmailCode());
}

const previousSecret = process.env.SECRET;

beforeEach(() => {
  process.env.SECRET = "test-secret";
  resetFallbackCodeLimiter();
  provider = new MemoryProvider();
  vi.stubEnv("AUTH_FIXED_CODE", "");
  vi.stubEnv("AUTH_FIXED_CODE_ALLOW_PRODUCTION", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.SECRET = previousSecret;
});

describe("the fixed code in development", () => {
  test("AUTH_FIXED_CODE signs in any address, with no code issued", async () => {
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    auth = manager();
    const result = await verify({ email: EMAIL, code: "000000", name: "Ada" });
    expect(result).toMatchObject({ isNewUser: true, session: { token: "session-token" } });
    expect(provider.users).toEqual([expect.objectContaining({ email: EMAIL, name: "Ada" })]);

    // Reusable: it is never claimed.
    expect(await verify({ email: EMAIL, code: "000000" })).toMatchObject({ isNewUser: false });
    expect(await verify({ email: "bob@example.com", code: "000000" })).toMatchObject({
      isNewUser: true,
    });
  });

  test("auth.emailCode.fixedCode works the same and wins over the variable", async () => {
    vi.stubEnv("AUTH_FIXED_CODE", "999999");
    auth = manager({ fixedCode: "424242" });
    expect(await verify({ email: EMAIL, code: "424242" })).toMatchObject({ isNewUser: true });
    await expect(verify({ email: EMAIL, code: "999999" })).rejects.toMatchObject({
      errors: { code: ["invalid_code"] },
    });
  });

  test('fixedCode: "" turns the variable off', async () => {
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    auth = manager({ fixedCode: "" });
    await expect(verify({ email: EMAIL, code: "000000" })).rejects.toMatchObject({
      errors: { code: ["invalid_code"] },
    });
  });

  test("a wrong code is still refused, and counts as a guess", async () => {
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    auth = manager({ maxAttempts: 1 });
    const { pin } = await auth.issueOneTimeCode(EMAIL, 6);
    const wrong = pin === "111111" ? "222222" : "111111";
    await expect(verify({ email: EMAIL, code: wrong })).rejects.toMatchObject({
      errors: { code: ["invalid_code"] },
    });
    await expect(verify({ email: EMAIL, code: pin })).rejects.toMatchObject({
      errors: { code: ["too_many_attempts"] },
    });
    // The fixed code does not depend on the issued one.
    expect(await verify({ email: EMAIL, code: "000000" })).toMatchObject({ isNewUser: true });
  });

  test("the issued code still works, once", async () => {
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    auth = manager();
    const { pin } = await auth.issueOneTimeCode(EMAIL, 6);
    expect(await verify({ email: EMAIL, code: pin })).toMatchObject({ isNewUser: true });
    expect(provider.rows).toHaveLength(0);
    await expect(verify({ email: EMAIL, code: pin })).rejects.toMatchObject({
      errors: { code: ["invalid_code"] },
    });
  });

  test("without createUser, an unknown address is still refused", async () => {
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    auth = manager({ createUser: false });
    await expect(verify({ email: EMAIL, code: "000000" })).rejects.toMatchObject({
      errors: { code: ["invalid_code"] },
    });
  });

  test("unset, nothing changes", async () => {
    auth = manager();
    await expect(verify({ email: EMAIL, code: "000000" })).rejects.toMatchObject({
      errors: { code: ["invalid_code"] },
    });
    expect(matchesFixedSignInCode("", { fixedCode: null })).toBe(false);
  });
});

describe("isFixedSignInCode, for an app's own code flow", () => {
  test("honours AUTH_FIXED_CODE, in constant time, and nothing in production", async () => {
    const { fixedSignInCode, isFixedSignInCode } = await import("./isFixedSignInCode");
    expect(isFixedSignInCode("000000")).toBe(false);
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    expect(fixedSignInCode()).toBe("000000");
    expect(isFixedSignInCode("000000")).toBe(true);
    expect(isFixedSignInCode("000001")).toBe(false);
    expect(isFixedSignInCode(123456)).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(fixedSignInCode()).toBe(null);
    expect(isFixedSignInCode("000000")).toBe(false);
  });
});

describe("in production", () => {
  test("AUTH_FIXED_CODE fails the boot with a clear error", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    expect(() => checkFixedSignInCode()).toThrow(
      /AUTH_FIXED_CODE is set.*refused when NODE_ENV=production/,
    );
    expect(() => emailCodeDefaults({})).toThrow(/AUTH_FIXED_CODE/);
    expect(() => authConfigDefaults({})).toThrow(/AUTH_FIXED_CODE/);
  });

  test("auth.emailCode.fixedCode fails the boot too", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => emailCodeDefaults({ fixedCode: "000000" })).toThrow(
      /auth\.emailCode\.fixedCode is set/,
    );
  });

  test("the code is rejected at sign-in", async () => {
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    auth = manager();
    vi.stubEnv("NODE_ENV", "production");
    await expect(verify({ email: EMAIL, code: "000000" })).rejects.toMatchObject({
      errors: { code: ["invalid_code"] },
    });
  });

  test("the provider's boot refuses it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    const { AuthServiceProvider } = await import("./AuthServiceProvider");
    const provider = new AuthServiceProvider({
      config: { get: () => ({}) },
    } as never);
    expect(() => provider.boot()).toThrow(/refused when NODE_ENV=production/);
  });

  test("a request never matches it", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(matchesFixedSignInCode("000000", { fixedCode: "000000" })).toBe(false);
  });

  test("unset, production boots as before", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => emailCodeDefaults({})).not.toThrow();
    expect(() => emailCodeDefaults({ fixedCode: "" })).not.toThrow();
  });
});

describe("in production, opted in", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  async function bootProvider(config: Record<string, unknown> = {}) {
    const { AuthServiceProvider } = await import("./AuthServiceProvider");
    return new AuthServiceProvider({ config: { get: () => config } } as never).boot();
  }

  test("AUTH_FIXED_CODE_ALLOW_PRODUCTION=1 boots, warns and signs in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    vi.stubEnv("AUTH_FIXED_CODE_ALLOW_PRODUCTION", "1");
    await bootProvider();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toMatch(/fixed sign-in code is enabled in production/);
    expect(message).toMatch(/AUTH_FIXED_CODE_ALLOW_PRODUCTION=1/);
    expect(message).toMatch(/sign in as any user/);
    expect(message).toMatch(/local test servers only/);

    auth = manager();
    expect(await verify({ email: EMAIL, code: "000000" })).toMatchObject({ isNewUser: true });
    await expect(verify({ email: EMAIL, code: "000001" })).rejects.toMatchObject({
      errors: { code: ["invalid_code"] },
    });
    const { fixedSignInCode, isFixedSignInCode } = await import("./isFixedSignInCode");
    expect(fixedSignInCode()).toBe("000000");
    expect(isFixedSignInCode("000000")).toBe(true);
  });

  test("auth.emailCode.allowFixedCodeInProduction: true opts in too", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await bootProvider({
      emailCode: { fixedCode: "424242", allowFixedCodeInProduction: true },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    auth = manager({ fixedCode: "424242", allowFixedCodeInProduction: true });
    expect(await verify({ email: EMAIL, code: "424242" })).toMatchObject({ isNewUser: true });
  });

  test("allowFixedCodeInProduction: false wins over the variable", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    vi.stubEnv("AUTH_FIXED_CODE_ALLOW_PRODUCTION", "1");
    expect(() => emailCodeDefaults({ allowFixedCodeInProduction: false })).toThrow(
      /refused when NODE_ENV=production/,
    );
    expect(matchesFixedSignInCode("000000", { allowFixedCodeInProduction: false })).toBe(false);
  });

  test.each(["true", "yes", "0", " 1", "1 ", "01"])(
    "AUTH_FIXED_CODE_ALLOW_PRODUCTION=%j is not an opt-in",
    async (value) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("AUTH_FIXED_CODE", "000000");
      vi.stubEnv("AUTH_FIXED_CODE_ALLOW_PRODUCTION", value);
      await expect(bootProvider()).rejects.toThrow(/refused when NODE_ENV=production/);
      expect(matchesFixedSignInCode("000000", {})).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test("a non-boolean allowFixedCodeInProduction is refused", () => {
    expect(() => emailCodeDefaults({ allowFixedCodeInProduction: "1" as never })).toThrow(
      /allowFixedCodeInProduction must be a boolean/,
    );
  });

  test("the whitespace and length checks still apply", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_FIXED_CODE_ALLOW_PRODUCTION", "1");
    vi.stubEnv("AUTH_FIXED_CODE", " 000000");
    expect(() => emailCodeDefaults({})).toThrow(/no surrounding whitespace/);
    vi.stubEnv("AUTH_FIXED_CODE", "x".repeat(257));
    expect(() => emailCodeDefaults({})).toThrow(/at most 256 characters/);
  });

  test("the opt-in alone, with no code, changes nothing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_FIXED_CODE_ALLOW_PRODUCTION", "1");
    await bootProvider();
    expect(warn).not.toHaveBeenCalled();
    expect(matchesFixedSignInCode("000000", {})).toBe(false);
  });

  test("in development the opt-in does not warn", async () => {
    vi.stubEnv("AUTH_FIXED_CODE", "000000");
    vi.stubEnv("AUTH_FIXED_CODE_ALLOW_PRODUCTION", "1");
    await bootProvider();
    expect(warn).not.toHaveBeenCalled();
  });
});
