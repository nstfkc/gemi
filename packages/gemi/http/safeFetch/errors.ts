import type { AddressRange } from "./addresses";

/**
 * Every refusal and failure `safeFetch` throws is one of these, so an app can
 * tell the user what went wrong in plain words (`error.code`) without parsing
 * messages. An abort through the caller's own `signal` rethrows that signal's
 * reason instead, as `fetch` does.
 */
export class SafeFetchError extends Error {
  readonly code: string = "safe-fetch";
  /** The URL being fetched when it failed: the redirect hop, not the first URL. */
  readonly url: string;

  constructor(message: string, url: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.url = url;
  }
}

export type InvalidUrlReason = "malformed" | "scheme" | "credentials" | "port";

/** Not an absolute http(s) URL, has a username or password, or uses a port not allowed. */
export class InvalidUrlError extends SafeFetchError {
  override readonly code = "invalid-url";
  constructor(
    url: string,
    readonly reason: InvalidUrlReason,
    message: string,
  ) {
    super(message, url);
  }
}

/** The host name is on `deny`, or `allow` is set and the host is not on it. */
export class BlockedHostError extends SafeFetchError {
  override readonly code = "blocked-host";
  constructor(
    url: string,
    readonly host: string,
    readonly reason: "denied" | "not-allowed",
  ) {
    super(
      reason === "denied"
        ? `Requests to ${host} are not allowed.`
        : `${host} is not on the list of hosts this request may reach.`,
      url,
    );
  }
}

/**
 * The host is, or resolves to, an address that is not on the public internet
 * (loopback, private, link-local, cloud metadata, …) or one matching `deny`.
 */
export class BlockedAddressError extends SafeFetchError {
  override readonly code = "blocked-address";
  constructor(
    url: string,
    readonly host: string,
    readonly address: string,
    readonly range: AddressRange | "denied" | "not-allowed",
  ) {
    super(
      host === address
        ? `${address} is not a public address (${range}).`
        : `${host} resolves to ${address}, which is not a public address (${range}).`,
      url,
    );
  }
}

/** The host name did not resolve. */
export class DnsError extends SafeFetchError {
  override readonly code = "dns";
  constructor(
    url: string,
    readonly host: string,
    cause?: unknown,
  ) {
    super(`Couldn't resolve ${host}.`, url, { cause });
  }
}

/** `connectTimeout` (resolving and connecting) or `timeout` (the whole request, body included) ran out. */
export class TimeoutError extends SafeFetchError {
  override readonly code = "timeout";
  constructor(
    url: string,
    readonly phase: "connect" | "total",
    readonly ms: number,
  ) {
    super(
      phase === "connect"
        ? `Couldn't connect within ${ms} ms.`
        : `The request didn't finish within ${ms} ms.`,
      url,
    );
  }
}

/** The response body is larger than `maxSize` bytes (decoded). */
export class TooLargeError extends SafeFetchError {
  override readonly code = "too-large";
  constructor(
    url: string,
    readonly limit: number,
  ) {
    super(`The response is larger than ${limit} bytes.`, url);
  }
}

/** The response's content type is not one of `contentTypes`. */
export class ContentTypeError extends SafeFetchError {
  override readonly code = "content-type";
  constructor(
    url: string,
    readonly contentType: string | null,
    readonly allowed: readonly string[],
  ) {
    super(
      `The response is ${contentType ?? "of no content type"}, not ${allowed.join(" or ")}.`,
      url,
    );
  }
}

/** More than `maxRedirects` redirects. */
export class TooManyRedirectsError extends SafeFetchError {
  override readonly code = "too-many-redirects";
  constructor(
    url: string,
    readonly limit: number,
  ) {
    super(`More than ${limit} redirects.`, url);
  }
}

/** The connection failed or broke (refused, reset, TLS, a malformed response). */
export class NetworkError extends SafeFetchError {
  override readonly code = "network";
  constructor(url: string, cause: unknown) {
    super(
      `The request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      url,
      { cause },
    );
  }
}
