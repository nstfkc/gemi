import { createHmac, randomBytes } from "node:crypto";

/**
 * Session tokens, and the one-time move off the old ones.
 *
 * ## The old token was computable
 *
 * It was `sha256(email + User-Agent)`: no secret and no randomness, so anyone
 * who knew a user's email and could guess their client could compute a token
 * that `findSession` would accept. It was also the same on every sign-in from
 * that client, so a leaked one survived signing in again, and it went to
 * whoever held the email next — a user who took over a freed address was
 * handed the previous owner's session.
 *
 * ## The new one
 *
 * `v2.` + HMAC-SHA256(secret, `userId:nonce`), with a fresh 16-byte nonce per
 * sign-in. The nonce is what makes it unguessable and different every time;
 * the secret means that even the inputs don't let anyone recompute it. The
 * token is not verified against the secret on the way in — it is looked up —
 * so rotating `SECRET` changes new tokens and signs nobody out.
 *
 * The prefix is how a token that predates this is recognised: a legacy one is
 * 64 hex characters and never starts with `v2.`. See `AuthManager.getSession`
 * for what happens to one.
 */
export const SESSION_TOKEN_PREFIX = "v2.";

/**
 * How long a legacy token keeps working after it has been exchanged for a
 * new one. Long enough for requests already in flight with the old cookie —
 * a page that fired several at once — to land; short enough that a computed
 * legacy token stops working soon after its owner's client moved on.
 */
export const LEGACY_TOKEN_GRACE_MS = 5 * 60_000;

export function isSessionToken(token: string): boolean {
  return token.startsWith(SESSION_TOKEN_PREFIX);
}

/**
 * The app's `SECRET`, the key CSRF and agent approvals are signed with too.
 *
 * Throws rather than falling back to anything: a token minted with a default
 * secret is one every other gemi app could mint too.
 */
export function sessionTokenSecret(): string {
  const secret = process.env.SECRET;
  if (!secret) {
    throw new Error(
      "Signing in needs a secret to mint session tokens with. Set SECRET in the environment.",
    );
  }
  return secret;
}

export function mintSessionToken(userId: number): string {
  const nonce = randomBytes(16).toString("hex");
  const mac = createHmac("sha256", sessionTokenSecret()).update(`${userId}:${nonce}`).digest("hex");
  return `${SESSION_TOKEN_PREFIX}${mac}`;
}

/**
 * The token a request's legacy token was exchanged for, keyed by the raw
 * request.
 *
 * `ApiRouteDispatcher.dispatchAs` replays the initiator's credentials on an
 * in-process request, and an agent run can outlast the grace period. Reading
 * the cookie the client sent would replay the token that is about to stop
 * working; this is the one the client is being handed instead.
 */
const replacedTokens = new WeakMap<Request, string>();

export function recordReplacedToken(request: Request, token: string): void {
  replacedTokens.set(request, token);
}

export function replacedToken(request: Request): string | undefined {
  return replacedTokens.get(request);
}
