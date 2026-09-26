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
 * The prefix is how a token that predates this is recognised: an old one is 64
 * hex characters and never starts with `v2.`. `AuthManager.getSession` refuses
 * it without looking it up, so the rows still holding old tokens grant nothing
 * whether or not they have been deleted.
 */
export const SESSION_TOKEN_PREFIX = "v2.";

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
