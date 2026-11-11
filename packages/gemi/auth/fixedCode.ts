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
 * either is set, and a request never matches it there. The exception is an
 * explicit opt-in for local production-build test servers:
 * `auth.emailCode.allowFixedCodeInProduction: true`, or
 * `AUTH_FIXED_CODE_ALLOW_PRODUCTION=1` when that is unset. With it the code is
 * accepted in production and the boot logs a warning.
 */

/** The `auth.emailCode` options the fixed code reads. */
export type FixedSignInCodeConfig = {
  fixedCode?: string | null;
  allowFixedCodeInProduction?: boolean | null;
};

/** `configured` if it is set (not `null`/`undefined`), else `AUTH_FIXED_CODE`; `""` is none. */
function pickFixedCode(configured: string | null | undefined): string | null {
  const value = configured ?? process.env.AUTH_FIXED_CODE;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Whether a fixed code may be used under `NODE_ENV=production`: the config's
 * `allowFixedCodeInProduction` when it is set, else exactly
 * `AUTH_FIXED_CODE_ALLOW_PRODUCTION=1`.
 */
function allowedInProduction(allow: boolean | null | undefined): boolean {
  if (allow !== undefined && allow !== null) return allow === true;
  return process.env.AUTH_FIXED_CODE_ALLOW_PRODUCTION === "1";
}

const PRODUCTION_WARNING =
  "[gemi] WARNING: a fixed sign-in code is enabled in production (AUTH_FIXED_CODE / auth.emailCode.fixedCode, opted in with AUTH_FIXED_CODE_ALLOW_PRODUCTION=1 / auth.emailCode.allowFixedCodeInProduction). Anyone who knows the code can sign in as any user. This is meant for local test servers only; never set it on a real deployment.";

/**
 * Throws when a fixed code is set (`fixedCode`, or `AUTH_FIXED_CODE`) and
 * `NODE_ENV` is `production` without the opt-in, or when it is not a usable
 * code. Run at boot by `AuthServiceProvider`, and when the auth config is
 * merged. With `warn`, logs the production warning when the opt-in lets a code
 * through (only the boot passes it, so it is logged once).
 */
export function checkFixedSignInCode(
  config: FixedSignInCodeConfig = {},
  { warn = false }: { warn?: boolean } = {},
) {
  const { fixedCode: configured, allowFixedCodeInProduction: allow } = config ?? {};
  if (configured !== undefined && configured !== null && typeof configured !== "string") {
    throw new Error(`auth.emailCode.fixedCode must be a string, got ${JSON.stringify(configured)}`);
  }
  if (allow !== undefined && allow !== null && typeof allow !== "boolean") {
    throw new Error(
      `auth.emailCode.allowFixedCodeInProduction must be a boolean, got ${JSON.stringify(allow)}`,
    );
  }
  const code = pickFixedCode(configured);
  if (code === null) return;
  const source = configured ? "auth.emailCode.fixedCode" : "AUTH_FIXED_CODE";
  const production = process.env.NODE_ENV === "production";
  if (production && !allowedInProduction(allow)) {
    throw new Error(
      `${source} is set, but a fixed sign-in code is for development and tests only and is refused when NODE_ENV=production. Unset it in this environment (a local production-build test server can opt in with AUTH_FIXED_CODE_ALLOW_PRODUCTION=1).`,
    );
  }
  if (code.trim() !== code || code.length > 256) {
    throw new Error(`${source} must have no surrounding whitespace and at most 256 characters`);
  }
  if (production && warn) console.warn(PRODUCTION_WARNING);
}

/**
 * The fixed sign-in code in effect, or `null`: none set, or `NODE_ENV` is
 * `production` without the opt-in. `fixedCode` wins over `AUTH_FIXED_CODE`,
 * and `allowFixedCodeInProduction` over `AUTH_FIXED_CODE_ALLOW_PRODUCTION`.
 * The variables are read on every call, so a `.env` reload in development
 * takes effect.
 */
export function fixedSignInCodeFrom(config: FixedSignInCodeConfig = {}): string | null {
  if (
    process.env.NODE_ENV === "production" &&
    !allowedInProduction(config.allowFixedCodeInProduction)
  ) {
    return null;
  }
  return pickFixedCode(config.fixedCode);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

/** Whether `code` is the fixed code `config` resolves to, in constant time. */
export function matchesFixedSignInCode(code: unknown, config: FixedSignInCodeConfig = {}): boolean {
  const fixed = fixedSignInCodeFrom(config);
  if (fixed === null || typeof code !== "string" || code === "") return false;
  return timingSafeEqual(digest(code), digest(fixed));
}
