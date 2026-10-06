import { createHmac, timingSafeEqual } from "node:crypto";

import { purposeKey } from "../../../ai/signing";

/**
 * State the transport hands a client and takes back: a legacy session id, an
 * elicitation's `requestState`. Both pass through the client, so both are
 * attacker-controlled on the way back in, and both are signed.
 *
 * `<tag>.<payload>.<mac>`: the payload is base64url JSON, the MAC is
 * HMAC-SHA256 over the tag and the payload under a key HKDF-derived from the
 * app's `SECRET` for this purpose alone (`purposeKey`), so a value signed for
 * one use can never verify as another — a session id is not a request state.
 * It is signed, not encrypted: nothing in it is a secret, and the client may
 * read it.
 *
 * Expiry is in the payload and checked here. Anything else a value is bound
 * to — the principal, the tool, the arguments — is the caller's to compare.
 */
export function sign(purpose: string, tag: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${tag}.${body}.${mac(purpose, tag, body).toString("base64url")}`;
}

/**
 * The payload of a value `sign` made for `purpose` and `tag`, or `null` when
 * it is malformed, forged, signed for something else, or expired (`exp`, in
 * epoch milliseconds, is required).
 */
export function verify<T extends { exp: number }>(
  purpose: string,
  tag: string,
  value: unknown,
  now = Date.now(),
): T | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== tag) return null;
  const [, body, signature] = parts;
  const presented = Buffer.from(signature, "base64url");
  const expected = mac(purpose, tag, body);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  return payload;
}

function mac(purpose: string, tag: string, body: string): Buffer {
  return createHmac("sha256", purposeKey(purpose)).update(`${tag}.${body}`).digest();
}
