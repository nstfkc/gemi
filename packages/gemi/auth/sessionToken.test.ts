import { afterEach, beforeEach, expect, test } from "vitest";

import {
  AuthManager,
  SESSION_TOKEN_PREFIX,
  isSessionToken,
  mintSessionToken,
} from "../services";

/**
 * The token helpers are public (#621), so an application that has to write a
 * session row itself mints the token gemi would, instead of copying the crypto
 * or reaching it through a throwaway `AuthManager`.
 */

const previousSecret = process.env.SECRET;
beforeEach(() => {
  process.env.SECRET = "test-secret";
});
afterEach(() => {
  process.env.SECRET = previousSecret;
});

test("gemi/services exports the session token helpers", () => {
  expect(SESSION_TOKEN_PREFIX).toBe("v2.");
  const token = mintSessionToken(1);
  expect(token).toMatch(/^v2\.[0-9a-f]{64}$/);
  expect(isSessionToken(token)).toBe(true);
  expect(mintSessionToken(1)).not.toBe(token);
});

test("isSessionToken refuses the bare-hex tokens from before 0.64", () => {
  expect(isSessionToken("a".repeat(64))).toBe(false);
  expect(isSessionToken("")).toBe(false);
});

test("migrating legacy sessions is off unless the app sets it", () => {
  expect(new AuthManager({}).config.migrateLegacySession).toBeNull();
});
