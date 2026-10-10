import { createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * The tag an event frame's `x` names a socket by: a keyed hash of its id.
 *
 * Subscribers see `x`, so it must not be the id: the id is what a client
 * sends in `X-Gemi-Socket` to have its own emits skip it, and a subscriber
 * who learned another's id could make the server skip that socket instead.
 * The tag cannot be turned back into the id.
 *
 * Keyed with a key derived from `SECRET`, so every instance of the app
 * computes the same tag for an id (the Redis driver carries frames between
 * them). Without `SECRET` the key is random per process, which is right for
 * one instance and wrong for several; the Redis driver needs `SECRET`.
 */
export function socketTag(socketId: string): string {
  return createHmac("sha256", tagKey()).update(socketId).digest("base64url").slice(0, 22);
}

let cached: { secret: string | undefined; key: Buffer } | null = null;

function tagKey(): Buffer {
  const secret = process.env.SECRET || undefined;
  if (cached && cached.secret === secret) return cached.key;
  const key = secret
    ? Buffer.from(hkdfSync("sha256", secret, "gemi", "gemi.broadcast.socket-tag", 32))
    : randomBytes(32);
  cached = { secret, key };
  return key;
}

/** A new socket id: 22 url-safe characters, 128 random bits. */
export function newSocketId(): string {
  return randomBytes(16).toString("base64url");
}
