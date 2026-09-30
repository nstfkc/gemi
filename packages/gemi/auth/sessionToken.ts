import { createHmac, randomBytes } from "node:crypto";

/**
 * Session tokens: minting them, and telling them from the computable ones they
 * replaced.
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
 * The prefix is the whole test, and it is all a prefix: `isSessionToken` reads
 * nothing else, so anything not starting with `v2.` is refused — an old token,
 * which was bare hex, and any other string alike. `AuthManager.getSession`
 * refuses it without looking it up, so the rows still holding old tokens grant
 * nothing whether or not they have been deleted — unless the application opts
 * in to converting them with `auth.migrateLegacySession`.
 *
 * `SESSION_TOKEN_PREFIX`, `isSessionToken` and `mintSessionToken` are exported
 * from `gemi/services`, for an application that writes session rows of its own
 * (#621).
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

/**
 * The token a legacy session is converted to, the same for every request that
 * converts `legacyToken` within one `window` bucket.
 *
 * Random tokens would make a conversion a race nobody but the winner can see
 * the outcome of: two requests carrying the same old cookie — a page's parallel
 * fetches — would each mint their own, and the one that lost could not find the
 * session the other made. Derived from the old token, every request computes the
 * token the winner wrote, so the losers read it back instead. The bucket is what
 * ends that: once it and the next have passed, the old token no longer names the
 * converted session, which is how it stops working at all.
 *
 * It is keyed with the secret like a minted token, so knowing the old token is
 * not enough to compute it — only to present the old token to gemi within the
 * bucket, which `AuthManager` bounds.
 */
export function migratedSessionToken(legacyToken: string, bucket: number): string {
  const mac = createHmac("sha256", sessionTokenSecret())
    .update(`legacy-session:${bucket}:${legacyToken}`)
    .digest("hex");
  return `${SESSION_TOKEN_PREFIX}${mac}`;
}
