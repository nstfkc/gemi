import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import * as zlib from "node:zlib";

import {
  classifyAddress,
  formatAddress,
  inCidr,
  parseAddress,
  parseCidr,
  sameAddress,
  unmap,
  type Cidr,
  type ParsedAddress,
} from "./addresses";
import {
  BlockedAddressError,
  BlockedHostError,
  ContentTypeError,
  DnsError,
  InvalidUrlError,
  NetworkError,
  SafeFetchError,
  TimeoutError,
  TooLargeError,
  TooManyRedirectsError,
} from "./errors";

export type SafeFetchOptions = {
  method?: string;
  headers?: HeadersInit;
  /** Anything `fetch` takes as a body; it is read into memory before sending. */
  body?: BodyInit | null;
  /** Aborting it rejects (or errors the body stream) with the signal's reason. */
  signal?: AbortSignal;
  /** The whole request in ms: every redirect hop and reading the body. Default 30 000. */
  timeout?: number;
  /**
   * Resolving and connecting (TCP and TLS), per hop, in ms. Default 10 000.
   * On Bun before 1.4, whose node:http doesn't report the connection, it runs
   * until the response headers arrive instead.
   */
  connectTimeout?: number;
  /** Largest response body accepted, in bytes after decompression. Default 10 MiB. */
  maxSize?: number;
  /** Redirects followed before `TooManyRedirectsError`. Default 5. */
  maxRedirects?: number;
  /** `"manual"` returns a redirect response as it is, without following it. Default `"follow"`. */
  redirect?: "follow" | "manual";
  /**
   * Media types the final response may have, e.g. `["text/html", "image/*"]`.
   * Anything else rejects with `ContentTypeError` before the body is read.
   */
  contentTypes?: readonly string[];
  /** Ports a URL may use. Default `[80, 443]`; `"any"` allows every port. */
  ports?: readonly number[] | "any";
  /**
   * When set, only these may be reached: host names (`"example.com"`, or
   * `"*.example.com"` for its subdomains) and IP ranges (`"203.0.113.0/24"`),
   * which every address the host resolves to must be in. An allowed host is
   * still refused when it resolves to a private address.
   */
  allow?: readonly string[];
  /** Host names and IP ranges never reached, in the same notation as `allow`. Wins over `allow`. */
  deny?: readonly string[];
  /**
   * Lets private, loopback and other non-public addresses through: `true` for
   * all of them (tests, local development), or a list of ranges
   * (`["10.20.0.0/16"]`) for an internal service. Never set it from user input.
   */
  allowPrivate?: boolean | readonly string[];
  /**
   * Resolves a host name to its addresses. Defaults to the system resolver
   * (`dns.lookup`, so `/etc/hosts` applies). The connection is made to the
   * addresses returned here, after they are checked; nothing resolves the
   * name again.
   */
  resolve?: (hostname: string) => Promise<readonly string[]>;
};

/**
 * The response of `safeFetch`: a standard `Response`, with `url` and
 * `redirected` filled in as `fetch` does, and the address it connected to.
 */
export class SafeResponse extends Response {
  readonly #url: string;
  readonly #redirected: boolean;
  /**
   * The IP address the response came from, or `null` when the runtime doesn't
   * report it (Bun before 1.4).
   */
  readonly address: string | null;

  constructor(
    body: ReadableStream<Uint8Array> | null,
    init: ResponseInit,
    meta: { url: string; redirected: boolean; address: string | null },
  ) {
    super(body, init);
    this.#url = meta.url;
    this.#redirected = meta.redirected;
    this.address = meta.address;
  }

  override get url() {
    return this.#url;
  }

  override get redirected() {
    return this.#redirected;
  }
}

const DEFAULTS = {
  timeout: 30_000,
  connectTimeout: 10_000,
  maxSize: 10 * 1024 * 1024,
  maxRedirects: 5,
  ports: [80, 443] as readonly number[],
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
// What the caller can't set: the connection is ours to describe.
const FORBIDDEN_HEADERS = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
];
// Dropped when a redirect leaves the origin, as `fetch` does.
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

type Rules = { hosts: string[]; ranges: Cidr[] };

type Policy = {
  timeout: number;
  connectTimeout: number;
  maxSize: number;
  maxRedirects: number;
  ports: readonly number[] | "any";
  allow: Rules | null;
  deny: Rules;
  allowPrivate: true | Cidr[];
  contentTypes: readonly string[] | null;
  resolve: (hostname: string) => Promise<readonly string[]>;
};

/**
 * `fetch` for URLs that come from users. It refuses anything but http(s) on
 * the allowed ports, resolves the host itself, refuses non-public addresses,
 * then connects to the address it checked (the host name is still sent as
 * `Host` and TLS SNI, and the certificate is verified against it), so a DNS
 * answer that changes between the check and the connection can't reach
 * inside. Each redirect is checked the same way.
 *
 * Throws `SafeFetchError` subclasses; see `errors.ts`.
 */
export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeResponse> {
  const policy = compilePolicy(options);
  const outer = options.signal;
  outer?.throwIfAborted();

  const controller = new AbortController();
  const signal = controller.signal;
  let currentUrl = String(input);
  const abortWith = (reason: unknown) => {
    if (!signal.aborted) controller.abort(reason);
  };
  const totalTimer = setTimeout(
    () => abortWith(new TimeoutError(currentUrl, "total", policy.timeout)),
    policy.timeout,
  );
  const onOuterAbort = () => abortWith(outer!.reason);
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  const release = () => {
    clearTimeout(totalTimer);
    outer?.removeEventListener("abort", onOuterAbort);
  };

  try {
    let url = parseUrl(currentUrl, policy);
    let method = (options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers);
    for (const name of FORBIDDEN_HEADERS) headers.delete(name);
    if (!headers.has("accept")) headers.set("accept", "*/*");
    // Some sites refuse a request without one, as `fetch` would always send.
    if (!headers.has("user-agent")) headers.set("user-agent", "gemi");
    if (!headers.has("accept-encoding"))
      headers.set("accept-encoding", "gzip, deflate, br");
    let body = await readBody(method, options.body, headers);

    for (let hop = 0; ; hop++) {
      currentUrl = url.href;
      const { request, response, address } = await send(
        url,
        method,
        headers,
        body,
        policy,
        signal,
      );
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (REDIRECTS.has(status) && location && options.redirect !== "manual") {
        request.destroy();
        if (hop >= policy.maxRedirects) {
          throw new TooManyRedirectsError(url.href, policy.maxRedirects);
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new InvalidUrlError(
            location,
            "malformed",
            `The redirect to "${location}" is not a URL.`,
          );
        }
        if (
          status === 303
            ? method !== "HEAD"
            : (status === 301 || status === 302) && method === "POST"
        ) {
          method = "GET";
          body = null;
          const bodyHeaders: string[] = [];
          headers.forEach((_, name) => {
            if (name.startsWith("content-")) bodyHeaders.push(name);
          });
          for (const name of bodyHeaders) headers.delete(name);
        }
        if (next.origin !== url.origin)
          for (const name of CREDENTIAL_HEADERS) headers.delete(name);
        url = parseUrl(next.href, policy);
        continue;
      }

      return toResponse({
        url,
        hop,
        method,
        request,
        response,
        address,
        policy,
        signal,
        release,
      });
    }
  } catch (error) {
    release();
    throw signal.aborted ? signal.reason : error;
  }
}

function compilePolicy(options: SafeFetchOptions): Policy {
  const rules = (list: readonly string[], option: string): Rules => {
    const result: Rules = { hosts: [], ranges: [] };
    for (const entry of list) {
      // Anything shaped like an address or a range must be a valid one: a
      // typo such as "10.0.0/8" must not quietly become a host name.
      const addressLike =
        entry.includes("/") || entry.includes(":") || /^[\d.]+$/.test(entry);
      const cidr = addressLike ? parseCidr(entry) : null;
      if (cidr) result.ranges.push(cidr);
      else if (
        !addressLike &&
        /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.?$/i.test(entry)
      ) {
        result.hosts.push(normalizeHost(entry));
      } else {
        throw new TypeError(
          `safeFetch: "${entry}" in ${option} is not a host name or an IP range.`,
        );
      }
    }
    return result;
  };
  const allowPrivate = options.allowPrivate;
  return {
    timeout: options.timeout ?? DEFAULTS.timeout,
    connectTimeout: options.connectTimeout ?? DEFAULTS.connectTimeout,
    maxSize: options.maxSize ?? DEFAULTS.maxSize,
    maxRedirects: options.maxRedirects ?? DEFAULTS.maxRedirects,
    ports: options.ports ?? DEFAULTS.ports,
    allow:
      options.allow && options.allow.length > 0
        ? rules(options.allow, "allow")
        : null,
    deny: rules(options.deny ?? [], "deny"),
    allowPrivate:
      allowPrivate === true
        ? true
        : rules(allowPrivate || [], "allowPrivate").ranges,
    contentTypes: options.contentTypes?.length ? options.contentTypes : null,
    resolve: options.resolve ?? systemResolve,
  };
}

async function systemResolve(hostname: string) {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function normalizeHost(host: string) {
  return host.toLowerCase().replace(/\.$/, "");
}

function matchesHost(host: string, patterns: string[]) {
  return patterns.some((pattern) =>
    pattern.startsWith("*.")
      ? host.endsWith(pattern.slice(1))
      : host === pattern,
  );
}

function parseUrl(text: string, policy: Policy): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InvalidUrlError(text, "malformed", `"${text}" is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(
      url.href,
      "scheme",
      `Only http and https URLs can be fetched, not ${url.protocol.slice(0, -1)}.`,
    );
  }
  if (url.username || url.password) {
    throw new InvalidUrlError(
      url.href,
      "credentials",
      "The URL has a username or password in it.",
    );
  }
  const port = effectivePort(url);
  if (policy.ports !== "any" && !policy.ports.includes(port)) {
    throw new InvalidUrlError(url.href, "port", `Port ${port} is not allowed.`);
  }
  return url;
}

function effectivePort(url: URL) {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/** The URL's host name without brackets, and its addresses once checked. */
async function vet(url: URL, policy: Policy, signal: AbortSignal) {
  // The WHATWG parser has already turned `0x7f.1`, `2130706433` and the like
  // into dotted quads, and lower-cased the name.
  const host = normalizeHost(url.hostname.replace(/^\[(.*)\]$/, "$1"));
  const literal = parseAddress(host);
  // A literal is judged as the URL parser canonicalised it; a name that only
  // looks numeric to us still goes to the resolver below.
  const isLiteral =
    literal !== null &&
    (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host));

  if (!isLiteral && matchesHost(host, policy.deny.hosts)) {
    throw new BlockedHostError(url.href, host, "denied");
  }
  const allowedByName =
    !isLiteral &&
    policy.allow !== null &&
    matchesHost(host, policy.allow.hosts);
  if (policy.allow && !allowedByName && policy.allow.ranges.length === 0) {
    throw new BlockedHostError(url.href, host, "not-allowed");
  }

  let addresses: ParsedAddress[];
  if (isLiteral) {
    addresses = [literal];
  } else {
    let answers: readonly string[];
    try {
      answers = await abortable(policy.resolve(host), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new DnsError(url.href, host, error);
    }
    addresses = answers
      .map((answer) => parseAddress(answer))
      .filter((answer) => answer !== null);
    if (addresses.length === 0) throw new DnsError(url.href, host);
  }

  // Every address must pass, not just the first: the connection may use any.
  for (const address of addresses) {
    const text = formatAddress(address);
    if (policy.deny.ranges.some((range) => inCidr(address, range))) {
      throw new BlockedAddressError(url.href, host, text, "denied");
    }
    if (
      policy.allow &&
      !allowedByName &&
      !policy.allow.ranges.some((range) => inCidr(address, range))
    ) {
      throw new BlockedAddressError(url.href, host, text, "not-allowed");
    }
    const blocked = classifyAddress(address);
    if (
      blocked &&
      policy.allowPrivate !== true &&
      !policy.allowPrivate.some((range) => inCidr(address, range))
    ) {
      throw new BlockedAddressError(url.href, host, text, blocked.kind);
    }
  }
  return { host, addresses, isLiteral };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBody(
  method: string,
  body: BodyInit | null | undefined,
  headers: Headers,
) {
  if (body === undefined || body === null) return null;
  if (method === "GET" || method === "HEAD") {
    throw new TypeError(`safeFetch: a ${method} request can't have a body.`);
  }
  // `Request` turns every BodyInit into bytes and knows its content type
  // (a FormData boundary, URLSearchParams, a Blob's type).
  const request = new Request("http://body.invalid/", { method: "POST", body });
  const type = request.headers.get("content-type");
  if (type && !headers.has("content-type")) headers.set("content-type", type);
  return new Uint8Array(await request.arrayBuffer());
}

type Sent = {
  request: http.ClientRequest;
  response: http.IncomingMessage;
  address: string | null;
};

/** One hop: check the URL's host, connect to the checked address, send. */
async function send(
  url: URL,
  method: string,
  headers: Headers,
  body: Uint8Array | null,
  policy: Policy,
  signal: AbortSignal,
): Promise<Sent> {
  const connectController = new AbortController();
  const connectTimer = setTimeout(
    () =>
      connectController.abort(
        new TimeoutError(url.href, "connect", policy.connectTimeout),
      ),
    policy.connectTimeout,
  );
  const connectSignal = AbortSignal.any([signal, connectController.signal]);
  try {
    const { host, addresses, isLiteral } = await vet(
      url,
      policy,
      connectSignal,
    );
    const secure = url.protocol === "https:";
    const outgoing: Record<string, string> = {};
    headers.forEach((value, name) => {
      outgoing[name] = value;
    });
    if (body) outgoing["content-length"] = String(body.byteLength);

    return await new Promise<Sent>((resolve, reject) => {
      const options: https.RequestOptions = {
        method,
        host,
        port: effectivePort(url),
        path: `${url.pathname}${url.search}`,
        headers: outgoing,
        // No pooling: a pooled socket was connected for some earlier hop, and
        // reusing it would skip the lookup below.
        agent: false,
        // The only resolution the connection sees: the addresses just checked.
        lookup: ((
          _hostname: string,
          lookupOptions: { all?: boolean; family?: number },
          callback: (...args: unknown[]) => void,
        ) => {
          const family = lookupOptions?.family;
          const candidates = addresses.filter(
            (address) => !family || address.family === family,
          );
          if (candidates.length === 0) {
            callback(
              Object.assign(new Error(`No IPv${family} address for ${host}`), {
                code: "ENOTFOUND",
              }),
            );
          } else if (lookupOptions?.all) {
            callback(
              null,
              candidates.map((address) => ({
                address: formatAddress(address),
                family: address.family,
              })),
            );
          } else {
            callback(null, formatAddress(candidates[0]), candidates[0].family);
          }
        }) as never,
      };
      if (secure && !isLiteral) options.servername = host;

      const request = (secure ? https : http).request(options);
      let connectedTo: string | null = null;
      const fail = (error: unknown) => {
        connectSignal.removeEventListener("abort", onAbort);
        request.destroy();
        reject(error);
      };
      const onAbort = () =>
        fail(connectSignal.aborted ? connectSignal.reason : signal.reason);
      connectSignal.addEventListener("abort", onAbort, { once: true });

      // Belt and braces: the socket must be at an address that was checked.
      // The lookup above is what guarantees it; this catches a runtime that
      // ever connects without it. Bun before 1.4 doesn't report the remote
      // address (or a connect event) from node:http, so there it can't run.
      const verify = (socket: Socket | null | undefined) => {
        const reported = socket?.remoteAddress;
        if (!reported || connectedTo !== null) return true;
        const remote = parseAddress(reported);
        if (
          !remote ||
          !addresses.some((address) => sameAddress(address, remote))
        ) {
          fail(
            new BlockedAddressError(url.href, host, reported, "not-allowed"),
          );
          return false;
        }
        connectedTo = formatAddress(unmap(remote));
        return true;
      };

      request.once("socket", (socket: Socket) => {
        const connected = () => {
          if (verify(socket) && !secure) clearTimeout(connectTimer);
        };
        if (socket.connecting) socket.once("connect", connected);
        else connected();
        if (secure)
          socket.once("secureConnect", () => clearTimeout(connectTimer));
      });
      request.once("response", (response) => {
        clearTimeout(connectTimer);
        // Destroying the request (a redirect, a refusal) can error the response.
        response.on("error", () => {});
        if (!verify(response.socket)) return;
        connectSignal.removeEventListener("abort", onAbort);
        // The total timeout and the caller's signal still apply to the body.
        resolve({ request, response, address: connectedTo });
      });
      // `on`, not `once`: a destroyed request can emit more than one error.
      request.on("error", (error) => {
        if (connectSignal.aborted) return fail(connectSignal.reason);
        fail(
          error instanceof SafeFetchError
            ? error
            : new NetworkError(url.href, error),
        );
      });
      request.end(body ?? undefined);
    });
  } finally {
    clearTimeout(connectTimer);
  }
}

function toResponse({
  url,
  hop,
  method,
  request,
  response,
  address,
  policy,
  signal,
  release,
}: {
  url: URL;
  hop: number;
  method: string;
  request: http.ClientRequest;
  response: http.IncomingMessage;
  address: string | null;
  policy: Policy;
  signal: AbortSignal;
  release: () => void;
}): SafeResponse {
  const status = response.statusCode ?? 0;
  if (status < 200 || status > 599) {
    request.destroy();
    throw new NetworkError(url.href, new Error(`Unexpected status ${status}`));
  }

  const headers = new Headers();
  const raw = response.rawHeaders;
  for (let index = 0; index < raw.length; index += 2)
    headers.append(raw[index], raw[index + 1]);

  if (policy.contentTypes) {
    const type =
      headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? null;
    if (
      !type ||
      !policy.contentTypes.some((allowed) => matchesMediaType(type, allowed))
    ) {
      request.destroy();
      throw new ContentTypeError(url.href, type, policy.contentTypes);
    }
  }

  const meta = { url: url.href, redirected: hop > 0, address };
  const init = { status, statusText: response.statusMessage ?? "", headers };
  if (method === "HEAD" || NULL_BODY.has(status)) {
    request.destroy();
    release();
    return new SafeResponse(null, init, meta);
  }

  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? zlib.createGunzip()
      : encoding === "deflate"
        ? zlib.createInflate()
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : null;
  const declared = Number(headers.get("content-length"));
  if (!decoder && Number.isFinite(declared) && declared > policy.maxSize) {
    request.destroy();
    throw new TooLargeError(url.href, policy.maxSize);
  }
  if (decoder) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }

  const source: Readable = decoder ? response.pipe(decoder) : response;
  let received = 0;
  let finished = false;
  let onAbort = () => {};
  const settle = () => {
    finished = true;
    signal.removeEventListener("abort", onAbort);
    release();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (error?: unknown) => {
        if (finished) return;
        settle();
        if (error === undefined) {
          controller.close();
        } else {
          request.destroy();
          decoder?.destroy();
          controller.error(error);
        }
      };
      onAbort = () => finish(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) return onAbort();

      source.on("data", (chunk: Buffer) => {
        if (finished) return;
        received += chunk.byteLength;
        if (received > policy.maxSize)
          return finish(new TooLargeError(url.href, policy.maxSize));
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.once("end", () => finish());
      const onError = (error: Error) =>
        finish(
          error instanceof SafeFetchError
            ? error
            : new NetworkError(url.href, error),
        );
      source.on("error", onError);
      if (decoder) response.on("error", onError);
      response.once("aborted", () =>
        finish(
          new NetworkError(url.href, new Error("The response was cut off.")),
        ),
      );
    },
    pull() {
      source.resume();
    },
    cancel() {
      if (finished) return;
      settle();
      request.destroy();
      decoder?.destroy();
    },
  });
  return new SafeResponse(stream, init, meta);
}

function matchesMediaType(type: string, allowed: string) {
  const pattern = allowed.toLowerCase();
  return pattern.endsWith("/*")
    ? type.startsWith(pattern.slice(0, -1))
    : type === pattern;
}
