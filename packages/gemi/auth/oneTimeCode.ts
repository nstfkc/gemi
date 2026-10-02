import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { app } from "../foundation/app";
import type { HttpRequest } from "../http/HttpRequest";
import { RateLimitExceededError, clientIp } from "../http/RateLimitMiddleware";
import { InMemoryRateLimiter } from "../services/rate-limiter/drivers/InMemoryRateLimiterDriver";
import { RateLimiter } from "../services/rate-limiter/RateLimiter";
import { sessionTokenSecret } from "./sessionToken";

/**
 * The one-time secrets behind `/auth/magic-link`, `/auth/sign-in-with-pin(-v2)`,
 * `/auth/sign-in/magic-link` and `/auth/email-code(/verify)` (#708).
 *
 * All of them live in the `MagicLinkToken` table, one row per email: a 256-bit
 * link `token` and a short numeric `pin`. Neither is stored as issued. Both
 * columns hold `h1.` + HMAC-SHA256 under the app's `SECRET`, keyed to the email
 * and to which of the two it is, so a database read alone gives an attacker
 * nothing to type: a 6-digit code is a million candidates, trivial to search
 * against a bare SHA-256, and a keyed hash takes that away.
 *
 * Verification reads the row by email and compares hashes with
 * `timingSafeEqual`, instead of asking the database for a row matching
 * `(pin, email)`. The schema is unchanged: the hash fits the existing `String`
 * columns, the `@@unique`s stay satisfied, and `createdAt` dates the row for
 * the expiry. The attempt count is kept in the rate limiter, keyed by the row,
 * so no column is needed for it either.
 */

/** The prefix a hashed column value carries. A value without it was written before 0.85. */
export const ONE_TIME_HASH_PREFIX = "h1.";

export type OneTimeSecretKind = "pin" | "link";

export function hashOneTimeSecret(kind: OneTimeSecretKind, email: string, value: string): string {
  const mac = createHmac("sha256", sessionTokenSecret())
    .update(`gemi:one-time:${kind}:${email}:${value}`)
    .digest("hex");
  return `${ONE_TIME_HASH_PREFIX}${mac}`;
}

/**
 * Whether `candidate` is what `stored` was issued as, in time that depends on
 * neither.
 *
 * A row written before hashing (a plain PIN or token, at most one expiry old
 * after the upgrade) is compared as it is, still in constant time, so a code
 * mailed moments before a deploy keeps working until it expires.
 */
export function oneTimeSecretMatches(
  kind: OneTimeSecretKind,
  email: string,
  stored: string | null | undefined,
  candidate: unknown,
): boolean {
  const given = typeof candidate === "string" ? candidate : "";
  const expected = typeof stored === "string" ? stored : "";
  const hashed = expected.startsWith(ONE_TIME_HASH_PREFIX);
  // Always hashed, so a request costs the same whether or not there is a row.
  const candidateHash = hashOneTimeSecret(kind, email, given);
  const a = Buffer.from(hashed ? candidateHash : given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || given === "" || expected === "") {
    // Still one comparison of the candidate's length, so a mismatch in length
    // costs what a mismatch in content does.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** `length` random decimal digits, each drawn without modulo bias. */
export function randomDigits(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String(randomInt(0, 10));
  }
  return out;
}

/**
 * The longest address any of these routes accepts: 64 for the local part, 1
 * for the `@`, 255 for the domain. Past it a value is refused before it becomes
 * a rate-limit key or a database lookup; the request body can be megabytes, and
 * a limiter keeps a key for every request it counted, refused or not.
 */
export const MAX_EMAIL_LENGTH = 320;

/**
 * What the magic-link and PIN routes have always done to an address: trim and
 * lowercase, nothing more, so an account they could reach before (an address
 * without a TLD, a synthetic identifier) is still reachable. `null` for what is
 * not a non-empty string, which used to be a 500, and for anything longer than
 * `MAX_EMAIL_LENGTH`.
 */
export function foldEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Trimmed before the length is checked, so the cap judges the address the
  // lookup will use: padding cannot push a real address past it (and onto the
  // IP budget only) while the lookup still finds the account.
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_EMAIL_LENGTH) return null;
  return trimmed.toLowerCase();
}

/**
 * The stricter form `/auth/email-code` takes: folded, and shaped like an
 * address, since it may create a user from it.
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Trimmed before the length is checked, as in `foldEmail`.
  const trimmed = value.trim();
  if (trimmed.length > MAX_EMAIL_LENGTH) return null;
  const email = trimmed.toLowerCase();
  // Not an RFC parser: enough to refuse what cannot be an address before a
  // row or a rate-limit key is made out of it.
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

/** `[count, windowSeconds]`, or `false` to switch that limit off. */
export type CodeRateLimit = [count: number, windowSeconds: number] | false;

export interface CodeRateLimits {
  perEmail?: CodeRateLimit;
  perIp?: CodeRateLimit;
}

let fallbackLimiter: RateLimiter | null = null;

/**
 * The app's rate limiter, or a process-local one when none is bound (a test, a
 * kernel without `RateLimiterServiceProvider`). Unlike `RateLimitMiddleware`,
 * this never skips limiting for want of a service: the attempt cap is what
 * keeps a 6-digit code from being guessed, so it has to count somewhere.
 */
export function codeLimiter(): RateLimiter {
  try {
    const container = app() as any;
    if (typeof container?.bound === "function" && container.bound(RateLimiter)) {
      return container.make(RateLimiter);
    }
  } catch {}
  fallbackLimiter ??= new RateLimiter({
    driver: new InMemoryRateLimiter(),
    limit: 1000,
    window: 60,
  });
  return fallbackLimiter;
}

/** Drops the process-local limiter's counters. For tests. */
export function resetFallbackCodeLimiter() {
  fallbackLimiter = null;
}

/**
 * A limiter key part as it is when short, else its SHA-256. The parts come
 * from the client (an address, an `x-forwarded-for`), and a key is held for
 * the whole window, so none may cost more than a hash's worth of memory.
 */
export function limiterKeyPart(value: string): string {
  return value.length <= 64 ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Spends one hit of each configured limit for `scope`, per IP first and then
 * per email, and throws the middleware's 429 (`{ error: { kind: "rate_limit" } }`)
 * on the first one that is spent. An IP over its limit does not also spend the
 * address's budget, so somebody hammering from one address cannot use up a
 * victim's.
 *
 * `email: null` spends the IP budget only: a request whose address was refused
 * (missing, malformed, over `MAX_EMAIL_LENGTH`) still counts against its IP,
 * but never makes a per-address key.
 */
export async function enforceCodeRateLimits(
  scope: "request" | "verify" | "link",
  email: string | null,
  req: HttpRequest<any, any>,
  limits: CodeRateLimits,
) {
  const limiter = codeLimiter();
  const checks: Array<[string, CodeRateLimit | undefined]> = [
    [`auth:code-${scope}:ip:${limiterKeyPart(clientIp(req as HttpRequest))}`, limits.perIp],
  ];
  if (email !== null) {
    checks.push([`auth:code-${scope}:email:${limiterKeyPart(email)}`, limits.perEmail]);
  }
  for (const [key, limit] of checks) {
    if (!limit) continue;
    const [count, window] = limit;
    const result = await limiter.consume(key, { limit: count, window });
    if (!result.allowed) {
      throw new RateLimitExceededError(result);
    }
  }
}

/**
 * Counts one guess at the code in row `rowId` and reports whether it is within
 * `maxAttempts`. The key names the row, so a newly issued code starts at zero.
 *
 * The limiter is a sliding window, which lets a count decay. The window is at
 * least a day and at least `(maxAttempts + 1)` code lifetimes, so over the
 * time a code can still be used the count decays by less than one guess and
 * the cap holds for any `expiresInMinutes` (#708).
 */
export async function countCodeAttempt(
  rowId: number | string,
  issuedAt: number,
  maxAttempts: number,
  expiresInMinutes = 10,
): Promise<boolean> {
  const window = Math.max(86_400, Math.ceil(expiresInMinutes * 60 * (maxAttempts + 1)));
  const result = await codeLimiter().consume(`auth:code-attempt:${rowId}:${issuedAt}`, {
    limit: maxAttempts,
    window,
  });
  return result.allowed;
}
