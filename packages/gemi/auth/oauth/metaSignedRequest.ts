import { createHmac, timingSafeEqual } from "node:crypto";

/** What a Meta `signed_request` says, once its signature checks out. */
export interface MetaSignedRequest {
  /** `"HMAC-SHA256"`. */
  algorithm: string;
  /**
   * The user the callback is about, as a string. For Facebook Login, the
   * app-scoped user id. For the Instagram API with Instagram Login it may be
   * the app-scoped id (`id` from `/me`) rather than the Instagram account id
   * (`user_id`), so keep both when an account is connected (`onConnected`'s
   * `profile` has both) and match against either.
   */
  user_id: string;
  /** Unix seconds. */
  issued_at?: number;
  /** Unix seconds; `0` or absent when it does not expire. */
  expires?: number;
  [key: string]: unknown;
}

/** Why `parseMetaSignedRequest` refused a `signed_request`. */
export class MetaSignedRequestError extends Error {
  constructor(
    readonly reason: "malformed" | "unsupported_algorithm" | "bad_signature" | "expired" | "missing_user",
    message: string,
  ) {
    super(message);
    this.name = "MetaSignedRequestError";
  }
}

/**
 * Parses and verifies the `signed_request` Meta POSTs to an app's
 * **deauthorize** and **data deletion** callbacks (Facebook Login, and the
 * Instagram API with Instagram Login): `<signature>.<payload>`, both
 * base64url, the signature an HMAC-SHA256 of the encoded payload under the
 * app secret. Throws `MetaSignedRequestError` unless the signature matches
 * (compared in constant time), the algorithm is HMAC-SHA256, it has not
 * expired, and it names a user.
 *
 * ```ts
 * const { user_id } = parseMetaSignedRequest(req.input.get("signed_request"), process.env.INSTAGRAM_CLIENT_SECRET!);
 * ```
 *
 * For Instagram the app secret is the **Instagram** app secret (the one the
 * Instagram providers use), not the Facebook app's.
 */
export function parseMetaSignedRequest(
  signedRequest: unknown,
  appSecret: string,
  options: { now?: number } = {},
): MetaSignedRequest {
  if (!appSecret) throw new Error("parseMetaSignedRequest needs the app secret.");
  if (typeof signedRequest !== "string") {
    throw new MetaSignedRequestError("malformed", "No signed_request was given.");
  }
  const dot = signedRequest.indexOf(".");
  if (dot <= 0 || dot === signedRequest.length - 1 || signedRequest.indexOf(".", dot + 1) !== -1) {
    throw new MetaSignedRequestError("malformed", "A signed_request is <signature>.<payload>.");
  }
  const encodedSignature = signedRequest.slice(0, dot);
  const encodedPayload = signedRequest.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encodedSignature) || !/^[A-Za-z0-9_-]+={0,2}$/.test(encodedPayload)) {
    throw new MetaSignedRequestError("malformed", "A signed_request is base64url.");
  }

  // The signature first: nothing in an unsigned payload is read.
  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  const given = Buffer.from(encodedSignature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new MetaSignedRequestError("bad_signature", "The signed_request's signature does not match the app secret.");
  }

  let payload: Record<string, unknown>;
  try {
    // Ids kept as strings: a 17-digit id does not fit a double.
    const json = Buffer.from(encodedPayload, "base64url")
      .toString("utf8")
      .replace(/("user_id"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"');
    payload = JSON.parse(json);
  } catch {
    throw new MetaSignedRequestError("malformed", "The signed_request's payload is not JSON.");
  }
  if (!payload || typeof payload !== "object") {
    throw new MetaSignedRequestError("malformed", "The signed_request's payload is not an object.");
  }

  if (String(payload.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") {
    throw new MetaSignedRequestError("unsupported_algorithm", "Only HMAC-SHA256 signed_requests are accepted.");
  }
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const expires = Number(payload.expires);
  if (Number.isFinite(expires) && expires > 0 && expires < now) {
    throw new MetaSignedRequestError("expired", "The signed_request has expired.");
  }
  const userId = payload.user_id;
  if ((typeof userId !== "string" || userId === "") && typeof userId !== "number") {
    throw new MetaSignedRequestError("missing_user", "The signed_request names no user.");
  }
  return { ...payload, algorithm: String(payload.algorithm), user_id: String(userId) } as MetaSignedRequest;
}
