import { SafeFetchError } from "../../http/safeFetch/errors";
import {
  safeFetch,
  type SafeFetchOptions,
} from "../../http/safeFetch/safeFetch";

/**
 * Why a source image couldn't be used, with the status the resize route
 * answers. The message is safe to send back: it never contains the URL.
 */
export class ImageSourceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ImageSourceError";
  }
}

export interface FetchSourceImageOptions {
  /** The origins that mean "this app": the request's, and `HOST_NAME`/`APP_URL`'s. */
  ownOrigins: readonly string[];
  /** Where the app's own images are fetched from, e.g. `http://localhost:5173`. */
  localOrigin: string;
  /** Other hosts images may come from (`safeFetch`'s `allow` notation). Empty: none. */
  allowedHosts: readonly string[];
  maxSize: number;
  /** The whole fetch, every redirect and the body, in ms. */
  timeout: number;
  maxRedirects?: number;
  /** Tests only: `resolve`, `allowPrivate` and `ports` for the allowed hosts. */
  external?: Pick<SafeFetchOptions, "resolve" | "allowPrivate" | "ports">;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Its own resize route fetching itself would recurse.
const RESIZE_PATH = "/api/__gemi__/services/image/";

/**
 * Fetches the source image of the resize route. Only the app's own images
 * (a path, or a URL on one of `ownOrigins`, read from `localOrigin`) and
 * images on `allowedHosts` (through `safeFetch`, so never a private address)
 * are fetched. Every redirect hop is checked by the same rules. The answer
 * must be `image/*` and at most `maxSize` bytes.
 */
export async function fetchSourceImage(
  raw: string,
  options: FetchSourceImageOptions,
): Promise<{ bytes: Buffer; cacheControl: string | null }> {
  const maxRedirects = options.maxRedirects ?? 5;
  const signal = AbortSignal.timeout(options.timeout);
  const base = options.ownOrigins[0] ?? options.localOrigin;

  let url = parseSource(raw, base);
  try {
    for (let hop = 0; ; hop++) {
      const response = await fetchHop(url, options, signal);
      const location = response.headers.get("location");
      if (REDIRECTS.has(response.status) && location) {
        await response.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) {
          throw new ImageSourceError(502, "The image redirects too many times");
        }
        url = parseSource(location, url.href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ImageSourceError(404, "Image not found");
      }
      const type = response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase();
      if (!type?.startsWith("image/")) {
        await response.body?.cancel().catch(() => {});
        throw new ImageSourceError(415, "The source is not an image");
      }
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        cacheControl: response.headers.get("cache-control"),
      };
    }
  } catch (error) {
    // A malformed `allowedHosts` entry is the app's mistake: let it surface.
    if (error instanceof TypeError && error.message.startsWith("safeFetch:")) {
      throw error;
    }
    throw toSourceError(error, signal);
  }
}

function parseSource(text: string, base: string) {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw new ImageSourceError(400, "The url parameter is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImageSourceError(400, "Only http(s) images can be resized");
  }
  return url;
}

async function fetchHop(
  url: URL,
  options: FetchSourceImageOptions,
  signal: AbortSignal,
) {
  const common = {
    method: "GET",
    redirect: "manual",
    signal,
    timeout: options.timeout,
    maxSize: options.maxSize,
    headers: { accept: "image/*" },
  } as const;

  let target = url;
  if (options.ownOrigins.includes(url.origin)) {
    if (url.pathname.startsWith(RESIZE_PATH)) {
      throw new ImageSourceError(403, "This image source is not allowed");
    }
    // A path starting with `//` or `/\` (also percent-encoded) is
    // protocol-relative: resolved against `localOrigin` it names another host.
    if (isProtocolRelative(url.pathname)) {
      throw new ImageSourceError(403, "This image source is not allowed");
    }
    // Only the path and query come from the request; the host is ours.
    const localOrigin = new URL(options.localOrigin).origin;
    const local = new URL(`${url.pathname}${url.search}`, localOrigin);
    if (local.origin === localOrigin) {
      return safeFetch(local, { ...common, allowPrivate: true, ports: "any" });
    }
    // Anything that isn't the app itself is just another host.
    target = local;
  }

  if (options.allowedHosts.length === 0) {
    throw new ImageSourceError(403, "This image source is not allowed");
  }
  return safeFetch(target, {
    ...options.external,
    ...common,
    allow: options.allowedHosts,
  });
}

function isProtocolRelative(pathname: string) {
  let path = pathname;
  // Decode until stable, so `%252F%252F` can't slip through either.
  for (let i = 0; i < 5; i++) {
    if (/^[/\\][/\\]/.test(path)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return true;
    }
    if (decoded === path) return false;
    path = decoded;
  }
  return true;
}

function toSourceError(error: unknown, signal: AbortSignal) {
  if (error instanceof ImageSourceError) return error;
  if (signal.aborted) {
    return new ImageSourceError(504, "The image took too long to load", {
      cause: error,
    });
  }
  if (error instanceof SafeFetchError) {
    switch (error.code) {
      case "blocked-host":
      case "blocked-address":
      case "invalid-url":
        return new ImageSourceError(403, "This image source is not allowed", {
          cause: error,
        });
      case "too-large":
        return new ImageSourceError(413, "The image is too large", {
          cause: error,
        });
      case "timeout":
        return new ImageSourceError(504, "The image took too long to load", {
          cause: error,
        });
    }
  }
  return new ImageSourceError(502, "The image could not be loaded", {
    cause: error,
  });
}
