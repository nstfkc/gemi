/**
 * Transport-level compression for SSR HTML responses.
 *
 * This lives in the runtime rather than in an app, because every gemi app
 * serves the same shape of response: a streamed `text/html` document whose
 * bulk is critical CSS, markup and the `window.__GEMI_DATA__` hydration
 * payload. Compressing it here means the win is portable across deployments —
 * it does not depend on a CDN being configured to compress on the origin's
 * behalf — and it also cuts origin→edge bandwidth, which edge compression
 * cannot.
 *
 * Compression stays strictly at the transport layer: what the client decodes
 * is byte-for-byte the HTML React rendered, so hydration is unaffected.
 *
 * Deliberately dependency-free apart from `node:zlib`/`node:stream` so it can
 * be unit tested without booting a server.
 */

import { Duplex } from "node:stream";
import { constants, createBrotliCompress, createGzip } from "node:zlib";

/** The content codings we can produce, in the order we prefer them. */
export type ContentEncoding = "br" | "gzip";

/**
 * Server preference, used to break q-value ties. Brotli comes first: at the
 * quality we use it is both smaller *and* no more expensive than gzip on a
 * representative SSR document (~177 kB → 28.0 kB in ~2.0 ms, versus 31.6 kB in
 * ~2.0 ms for gzip).
 */
const SERVER_PREFERENCE: ContentEncoding[] = ["br", "gzip"];

/**
 * Below this, an encoded body plus its framing overhead is not worth the CPU.
 * Only applied when the response declares a `Content-Length` — a streamed SSR
 * response does not, and buffering one just to measure it would defeat the
 * streaming render.
 */
const MIN_COMPRESSIBLE_BYTES = 1024;

/**
 * Brotli quality 5 (of 11). The default, 11, is meant for static assets
 * compressed once at build time — on a streamed document it costs ~175 ms,
 * two orders of magnitude more than quality 5 for ~12% more savings. Quality 5
 * is the usual choice for dynamic content.
 *
 * `LGWIN` 19 caps the window at 512 kB rather than the default 16 MB. An SSR
 * document is far smaller than that, so the ratio is unchanged, and the bound
 * matters under concurrency: the window is allocated per in-flight response.
 */
const BROTLI_QUALITY = 5;
const BROTLI_WINDOW_BITS = 19;

/** zlib's default level. Level 9 costs measurably more for ~1% on HTML. */
const GZIP_LEVEL = 6;

function parseQValue(raw: string | undefined): number {
  if (raw === undefined) {
    return 1;
  }
  // `q` is a fixed-point number with at most three decimals (RFC 9110 §12.4.2).
  // Anything else is malformed; treat it as an unqualified "acceptable" rather
  // than dropping the encoding, matching what tolerant servers do.
  if (!/^\d+(\.\d{0,3})?$/.test(raw.trim())) {
    return 1;
  }
  const value = Number(raw.trim());
  return Number.isFinite(value) ? Math.min(value, 1) : 1;
}

/**
 * Parses a request `Accept-Encoding` into `coding -> qvalue`.
 *
 * Returns `null` when the header is *absent*, which is distinct from an empty
 * one. RFC 9110 §12.5.3 says an absent header means any coding is acceptable,
 * but a client that cannot decode and forgets to say so is a broken page, not
 * a slow one — so we treat "absent" as "identity" and only encode when a
 * client has explicitly opted in. An empty header (`Accept-Encoding:`) is a
 * deliberate "identity only" and parses to an empty map.
 */
export function parseAcceptEncoding(header: string | null | undefined): Map<string, number> | null {
  if (header === null || header === undefined) {
    return null;
  }

  const accepted = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawCoding, ...params] = part.split(";");
    const coding = rawCoding.trim().toLowerCase();
    if (coding === "") {
      continue;
    }

    let q = 1;
    for (const param of params) {
      const separator = param.indexOf("=");
      if (separator === -1) {
        continue;
      }
      if (param.slice(0, separator).trim().toLowerCase() === "q") {
        q = parseQValue(param.slice(separator + 1));
        break;
      }
    }

    accepted.set(coding, q);
  }

  return accepted;
}

/**
 * Picks the coding to use, or `null` for identity.
 *
 * A `q=0` is a refusal, `*` covers codings the client did not name, and ties
 * fall back to `available`'s order — so a plain `Accept-Encoding: gzip, br`
 * (equal q of 1) resolves to our preference rather than the client's.
 */
export function negotiateEncoding(
  header: string | null | undefined,
  available: ContentEncoding[] = SERVER_PREFERENCE,
): ContentEncoding | null {
  const accepted = parseAcceptEncoding(header);
  if (!accepted) {
    return null;
  }

  const wildcard = accepted.get("*");
  let best: ContentEncoding | null = null;
  let bestQ = 0;

  for (const coding of available) {
    const q = accepted.get(coding) ?? wildcard ?? 0;
    if (q > bestQ) {
      best = coding;
      bestQ = q;
    }
  }

  return best;
}

function hasDirective(headerValue: string | null, directive: string): boolean {
  if (!headerValue) {
    return false;
  }
  // Token match, not substring: `no-transform` must not be found inside
  // something like `x-no-transform`.
  return headerValue
    .split(",")
    .some((token) => token.trim().toLowerCase().split("=")[0].trim() === directive);
}

/**
 * Whether this response's representation is one we may encode — and therefore
 * one that varies by `Accept-Encoding`, even on the requests where we end up
 * sending identity.
 *
 * HTML only, on purpose. JSON view-data and API responses are left alone so
 * that this change cannot alter how they are produced, framed or cached;
 * widening the set is a separate decision.
 */
export function isCompressible(method: string, res: Response): boolean {
  // A HEAD response carries no body to encode, and emitting `Content-Encoding`
  // without one would describe a body the client never receives.
  if (method === "HEAD") {
    return false;
  }

  if (!res.body) {
    return false;
  }

  // 204/304 are bodyless; 206 is a byte range of an already-committed
  // representation and re-encoding it would invalidate its `Content-Range`.
  if (res.status < 200 || res.status === 204 || res.status === 206 || res.status === 304) {
    return false;
  }

  if (res.headers.has("Content-Range")) {
    return false;
  }

  const contentType = res.headers.get("Content-Type");
  if (!contentType || !/^\s*text\/html\s*(;|$)/i.test(contentType)) {
    return false;
  }

  // Already encoded upstream — `identity` is the one value that means "not
  // encoded" and is safe to replace.
  const contentEncoding = res.headers.get("Content-Encoding");
  if (contentEncoding && contentEncoding.trim().toLowerCase() !== "identity") {
    return false;
  }

  // RFC 9110 §5.2.2.6: `no-transform` forbids intermediaries *and* us from
  // changing the representation's encoding.
  if (hasDirective(res.headers.get("Cache-Control"), "no-transform")) {
    return false;
  }

  const contentLength = res.headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) < MIN_COMPRESSIBLE_BYTES) {
    return false;
  }

  return true;
}

/**
 * Builds the encoder as a web `TransformStream`-shaped pair.
 *
 * Both codings are driven through `node:zlib` with an explicit per-write flush.
 * Without it the compressor holds output until its internal buffer fills,
 * which would sit on React's shell flush and turn a streamed render into a
 * buffered one — the compression win would be paid for in time to first byte.
 */
export function createEncoderStream(encoding: ContentEncoding) {
  const compressor =
    encoding === "br"
      ? createBrotliCompress({
          params: {
            [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
            [constants.BROTLI_PARAM_LGWIN]: BROTLI_WINDOW_BITS,
          },
          flush: constants.BROTLI_OPERATION_FLUSH,
        })
      : createGzip({ level: GZIP_LEVEL, flush: constants.Z_SYNC_FLUSH });

  return Duplex.toWeb(compressor) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

function withVaryAcceptEncoding(headers: Headers) {
  const vary = headers.get("Vary");
  if (!vary) {
    headers.set("Vary", "Accept-Encoding");
    return;
  }
  const tokens = vary.split(",").map((token) => token.trim().toLowerCase());
  // `Vary: *` already means "never reuse for another request"; narrowing it
  // would be a downgrade.
  if (tokens.includes("*") || tokens.includes("accept-encoding")) {
    return;
  }
  headers.append("Vary", "Accept-Encoding");
}

/**
 * Compresses an SSR HTML response when the client asked for it.
 *
 * Non-HTML responses are returned untouched — same object, same body, so this
 * is safe to apply at the edge of the server for every request.
 *
 * HTML responses always gain `Vary: Accept-Encoding`, whether or not this
 * particular request got an encoded body: without it a shared cache could
 * serve a stored encoded variant to a client that cannot decode it.
 */
export function compressResponse(req: Request, res: Response): Response {
  if (!isCompressible(req.method, res)) {
    return res;
  }

  const headers = new Headers(res.headers);
  withVaryAcceptEncoding(headers);

  const encoding = negotiateEncoding(req.headers.get("Accept-Encoding"));
  if (!encoding) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  let encoder: ReadableWritablePair<Uint8Array, Uint8Array>;
  try {
    encoder = createEncoderStream(encoding);
  } catch {
    // A compressor we cannot construct is not worth failing a page render
    // over. Serve identity — with the `Vary` we already added.
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  headers.set("Content-Encoding", encoding);
  // The length of the identity representation says nothing about the encoded
  // body, and a stale one would truncate the response.
  headers.delete("Content-Length");

  return new Response(res.body!.pipeThrough(encoder), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
