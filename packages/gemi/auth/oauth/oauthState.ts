import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { sessionTokenSecret } from "../sessionToken";

/**
 * The `state` and PKCE verifier of one OAuth round trip, kept in the browser
 * that started it.
 *
 * `oauthRedirect` mints a random `state` and a PKCE `code_verifier`, sends the
 * provider `state` and the verifier's S256 challenge, and writes both into a
 * short-lived cookie. `oauthCallback` reads the cookie back, deletes it, and
 * refuses the callback unless the `state` the provider echoed is the one in the
 * cookie. That is what ties a callback to the browser that asked for it: a
 * callback URL carrying someone else's `code` arrives without a matching cookie,
 * and is refused instead of signing this browser into their account.
 *
 * The cookie, and not process memory: any process can finish a round trip any
 * other process started.
 *
 * - **Signed** with the app's `SECRET` (HMAC-SHA256, domain-separated from the
 *   other uses of that secret), so a tampered or hand-written cookie is refused.
 * - **`HttpOnly`**, so page script never sees the verifier.
 * - **`SameSite=Lax`**: the callback is a top-level navigation from the
 *   provider's site, on which a `Strict` cookie is not sent.
 * - **`__Host-` prefixed on https**: a browser accepts such a cookie only from
 *   this exact host, `Secure`, `Path=/` and without `Domain`, so a sibling
 *   subdomain cannot plant one of its own (cookie tossing).
 * - **Ten minutes**, in the cookie's `Max-Age` and again in the signed payload.
 * - **Single use**: the callback deletes it whatever the outcome, and a state
 *   that has been consumed is also remembered by this process until it would
 *   have expired.
 */

export const OAUTH_STATE_TTL_SECONDS = 60 * 10;

const COOKIE_NAME = "gemi_oauth";
const SECURE_COOKIE_NAME = `__Host-${COOKIE_NAME}`;

export function oauthStateCookieName(secure: boolean): string {
  return secure ? SECURE_COOKIE_NAME : COOKIE_NAME;
}

export interface OAuthStatePayload {
  /** The provider key the round trip was started for. */
  provider: string;
  state: string;
  codeVerifier: string;
  /** Epoch milliseconds after which the round trip is refused. */
  expiresAt: number;
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function mac(payload: string): Buffer {
  return createHmac("sha256", sessionTokenSecret()).update(`gemi-oauth-state:${payload}`).digest();
}

/** Equal-length digests, so neither the contents nor the length leaks through timing. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

/** A fresh `state` and PKCE pair. */
export function createOAuthState(provider: string, now = Date.now()) {
  const state = base64url(randomBytes(32));
  // 32 random bytes → 43 base64url characters, inside RFC 7636's 43–128.
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = pkceChallenge(codeVerifier);
  const payload: OAuthStatePayload = {
    provider,
    state,
    codeVerifier,
    expiresAt: now + OAUTH_STATE_TTL_SECONDS * 1000,
  };
  return { state, codeVerifier, codeChallenge, cookieValue: sealOAuthState(payload) };
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function pkceChallenge(codeVerifier: string): string {
  return base64url(createHash("sha256").update(codeVerifier).digest());
}

export function sealOAuthState(payload: OAuthStatePayload): string {
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${base64url(mac(body))}`;
}

/** The payload of a cookie this app signed, or `null` for anything else. */
export function openOAuthState(value: string | null | undefined): OAuthStatePayload | null {
  if (typeof value !== "string" || value === "") return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot !== value.lastIndexOf(".")) return null;
  const body = value.slice(0, dot);
  const presented = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = mac(body);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (
      typeof payload?.provider !== "string" ||
      typeof payload?.state !== "string" ||
      typeof payload?.codeVerifier !== "string" ||
      typeof payload?.expiresAt !== "number"
    ) {
      return null;
    }
    return payload as OAuthStatePayload;
  } catch {
    return null;
  }
}

/**
 * States this process has already accepted, until they would have expired.
 * The cookie being deleted is what makes a state single-use; this only stops
 * the same cookie being presented twice to one process.
 */
const consumed = new Map<string, number>();
const MAX_CONSUMED = 10_000;

function rememberConsumed(state: string, expiresAt: number, now: number) {
  if (consumed.size >= MAX_CONSUMED) {
    for (const [key, expiry] of consumed) {
      if (expiry <= now) consumed.delete(key);
    }
    // Still full of live entries: drop the oldest, which are the first inserted.
    while (consumed.size >= MAX_CONSUMED) {
      const oldest = consumed.keys().next().value;
      if (oldest === undefined) break;
      consumed.delete(oldest);
    }
  }
  consumed.set(state, expiresAt);
}

/** For tests. */
export function clearConsumedOAuthStates() {
  consumed.clear();
}

export type OAuthStateCheck =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: "missing_state" | "invalid_state" | "expired_state" };

/**
 * Whether `returnedState` (the callback's `?state=`) completes the round trip
 * recorded in `cookieValue` for `provider`. A successful check consumes it.
 */
export function verifyOAuthState(args: {
  provider: string;
  cookieValue: string | null | undefined;
  returnedState: string | null | undefined;
  now?: number;
}): OAuthStateCheck {
  const now = args.now ?? Date.now();
  if (!args.cookieValue || !args.returnedState) {
    return { ok: false, reason: "missing_state" };
  }
  const payload = openOAuthState(args.cookieValue);
  if (!payload) return { ok: false, reason: "invalid_state" };
  // Both compared before either answer is used, so a mismatch in one does not
  // skip the other's comparison.
  const stateMatches = constantTimeEqual(payload.state, args.returnedState);
  const providerMatches = constantTimeEqual(payload.provider, args.provider);
  if (!stateMatches || !providerMatches) return { ok: false, reason: "invalid_state" };
  if (payload.expiresAt <= now) return { ok: false, reason: "expired_state" };
  if (consumed.has(payload.state)) return { ok: false, reason: "invalid_state" };
  rememberConsumed(payload.state, payload.expiresAt, now);
  return { ok: true, payload };
}
