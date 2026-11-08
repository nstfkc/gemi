import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A fixed sign-in code for development and tests (#1190).
 *
 * `auth.emailCode.fixedCode`, or the `AUTH_FIXED_CODE` environment variable
 * when that is unset, is a code `/auth/email-code/verify` accepts for any
 * address, next to the code it issued. It exists so an e2e script or a local
 * test server can sign in without reading the code out of the debug email.
 *
 * It is refused in production: with `NODE_ENV=production` the boot fails while
 * either is set, and a request never matches it there.
 */

/** `configured` if it is set (not `null`/`undefined`), else `AUTH_FIXED_CODE`; `""` is none. */
function pickFixedCode(configured: string | null | undefined): string | null {
  const value = configured ?? process.env.AUTH_FIXED_CODE;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Throws when a fixed code is set (`configured`, or `AUTH_FIXED_CODE`) and
 * `NODE_ENV` is `production`, or when it is not a usable code. Run at boot by
 * `AuthServiceProvider`, and when the auth config is merged.
 */
export function checkFixedSignInCode(configured?: string | null) {
  if (configured !== undefined && configured !== null && typeof configured !== "string") {
    throw new Error(
      `auth.emailCode.fixedCode must be a string, got ${JSON.stringify(configured)}`,
    );
  }
  const code = pickFixedCode(configured);
  if (code === null) return;
  const source = configured ? "auth.emailCode.fixedCode" : "AUTH_FIXED_CODE";
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${source} is set, but a fixed sign-in code is for development and tests only and is refused when NODE_ENV=production. Unset it in this environment.`,
    );
  }
  if (code.trim() !== code || code.length > 256) {
    throw new Error(`${source} must have no surrounding whitespace and at most 256 characters`);
  }
}

/**
 * The fixed sign-in code in effect, or `null`: none set, or `NODE_ENV` is
 * `production`. `configured` is `auth.emailCode.fixedCode`, which wins over
 * `AUTH_FIXED_CODE`. The variable is read on every call, so a `.env` reload
 * in development takes effect.
 */
export function fixedSignInCodeFrom(configured: string | null | undefined): string | null {
  if (process.env.NODE_ENV === "production") return null;
  return pickFixedCode(configured);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

/** Whether `code` is the fixed code `configured` resolves to, in constant time. */
export function matchesFixedSignInCode(
  code: unknown,
  configured: string | null | undefined,
): boolean {
  const fixed = fixedSignInCodeFrom(configured);
  if (fixed === null || typeof code !== "string" || code === "") return false;
  return timingSafeEqual(digest(code), digest(fixed));
}
