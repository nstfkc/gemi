import { app } from "../foundation/app";
import { AuthManager } from "./AuthManager";
import {
  type FixedSignInCodeConfig,
  fixedSignInCodeFrom,
  matchesFixedSignInCode,
} from "./fixedCode";

/** `auth.emailCode` of the app's auth config, or `undefined` when none is bound. */
function configuredEmailCode(): FixedSignInCodeConfig | undefined {
  try {
    const container = app() as any;
    if (typeof container?.bound === "function" && container.bound(AuthManager)) {
      return container.make(AuthManager).config.emailCode;
    }
  } catch {}
  return undefined;
}

/**
 * The fixed sign-in code in effect (#1190): `auth.emailCode.fixedCode`, else
 * `AUTH_FIXED_CODE`. `null` when neither is set, and in production unless
 * `allowFixedCodeInProduction` / `AUTH_FIXED_CODE_ALLOW_PRODUCTION=1` opts in.
 */
export function fixedSignInCode(): string | null {
  return fixedSignInCodeFrom(configuredEmailCode());
}

/**
 * Whether `code` is the fixed sign-in code (see `fixedSignInCode`), compared in
 * constant time. `false` when none is set, and in production without the opt-in. For an app
 * with a code flow of its own that should honour the same setting as
 * `/auth/email-code/verify`:
 *
 * ```ts
 * import { isFixedSignInCode } from "gemi/services";
 *
 * if (isFixedSignInCode(code) || (await verifyMyCode(email, code))) {
 *   // signed in
 * }
 * ```
 */
export function isFixedSignInCode(code: unknown): boolean {
  return matchesFixedSignInCode(code, configuredEmailCode());
}
