/**
 * Which `X-Forwarded-For` entries the production server believes (#8).
 *
 * `X-Forwarded-For` is written by whoever sends the request. A client talking
 * to the app directly — or through a proxy that appends to the header rather
 * than replacing it — picks any address it likes, and `clientIp` (the rate
 * limiter's default key) used to read the left-most entry, which is exactly
 * the one the client wrote. So the server decides here, once, at the edge,
 * and hands the app a single address it can rely on:
 *
 * - `none` (the default): no proxy is trusted. The header is replaced with the
 *   socket's peer address, and `X-Real-IP` is dropped.
 * - `hops` (`GEMI_TRUST_PROXY=<n>`): the `n` proxies nearest the app are
 *   trusted. Each appends the address it was reached from, so the client is
 *   the `n`-th entry from the right of `X-Forwarded-For`. Anything
 *   further left was written by someone the app does not trust and is dropped.
 * - `all` (`GEMI_TRUST_PROXY=true`): the inbound header is passed through
 *   unchanged, as before 0.88. Only sound behind a proxy that overwrites
 *   `X-Forwarded-For` (and `X-Real-IP`) rather than appending to it.
 */
import { normalizeIpEntry } from "../http/clientAddress";
import { secretMatches } from "../services/router/DomainResolver";

export type ForwardedTrust =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "hops"; hops: number };

const NONE: ForwardedTrust = { kind: "none" };

/**
 * `GEMI_TRUST_PROXY` as a policy. Unset, empty, `false`, `off` and `0` trust
 * nothing; `true` trusts everything; a positive integer is a hop count.
 * Anything else throws, so a typo fails the boot instead of silently trusting
 * nothing (every client sharing the proxy's address) or everything.
 */
export function parseTrustProxy(value: string | undefined): ForwardedTrust {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "" || raw === "false" || raw === "off" || raw === "0") {
    return NONE;
  }
  if (raw === "true") {
    return { kind: "all" };
  }
  if (/^[1-9]\d*$/.test(raw)) {
    return { kind: "hops", hops: Number(raw) };
  }
  throw new Error(
    `GEMI_TRUST_PROXY must be "false", "true" or the number of proxies in front of the app (e.g. 1). Got ${JSON.stringify(value)}.`,
  );
}

/**
 * Rewrites `headers` so `X-Forwarded-For` holds what `trust` says the client
 * address is. `peer` is the socket's remote address — `null` for a unix
 * socket, where the immediate hop is still counted as one proxy.
 */
export function applyForwardedTrust(
  headers: Headers,
  peer: string | null,
  trust: ForwardedTrust,
): void {
  if (trust.kind === "all") {
    if (!headers.get("x-forwarded-for") && peer) {
      headers.set("x-forwarded-for", peer);
    }
    return;
  }

  // Under any other policy `X-Real-IP` is as client-written as the rest; the
  // address the app should use is the one left in `X-Forwarded-For`.
  headers.delete("x-real-ip");

  let client: string | null = peer;
  if (trust.kind === "hops") {
    const entries = (headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    // The chain is `entries` + `peer`; the client sits `hops` places left of
    // its end, i.e. `entries[entries.length - hops]`. A shorter chain than
    // expected means the request skipped a proxy, so its left-most hop is the
    // furthest thing seen — never anything further left than that.
    const index = entries.length - trust.hops;
    const chosen = index >= 0 ? entries[index] : entries[0];
    // A proxy may append the address it was reached from with its source port
    // (`203.0.113.7:51234`, `[2001:db8::1]:443`); the port differs per
    // connection, so it is dropped, or every request gets a rate-limit bucket
    // of its own. An entry that is not an address at all (`unknown`, junk a
    // short chain let the client write) is not believed: the peer is used.
    client = (chosen === undefined ? null : normalizeIpEntry(chosen)) ?? peer;
  }

  if (client) {
    headers.set("x-forwarded-for", client);
  } else {
    headers.delete("x-forwarded-for");
  }
}

/**
 * A header a proxy in front writes the client's address into, believed only on
 * a request that carries a secret only that proxy sends. Set with
 * `GEMI_CLIENT_IP_HEADER`, `GEMI_PROXY_SECRET_HEADER` and `GEMI_PROXY_SECRET`.
 * With `route.domains`, its `trustProxy` entries are tried first and this is
 * the fallback for a request none of them claims. Behind Azure Front Door:
 * `X-Azure-ClientIP`, proven by `X-Azure-FDID` carrying the profile's ID.
 */
export interface ClientIpHeaderTrust {
  /** Lowercased name of the header that carries the client's address. */
  header: string;
  /** Lowercased name of the header that carries the secret. */
  secretHeader: string;
  secret: string;
}

/** An RFC 9110 field name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MIN_SECRET_LENGTH = 16;

/**
 * `GEMI_CLIENT_IP_HEADER`, `GEMI_PROXY_SECRET_HEADER` and `GEMI_PROXY_SECRET`
 * as one policy, or `null` when none is set. A partial or malformed set throws,
 * so a typo fails the boot instead of silently trusting nothing — or, without
 * a secret, letting any client name its own address.
 */
export function parseClientIpHeaderTrust(
  env: Record<string, string | undefined>,
): ClientIpHeaderTrust | null {
  const header = env.GEMI_CLIENT_IP_HEADER?.trim() ?? "";
  const secretHeader = env.GEMI_PROXY_SECRET_HEADER?.trim() ?? "";
  const secret = env.GEMI_PROXY_SECRET ?? "";
  if (header === "" && secretHeader === "" && secret === "") {
    return null;
  }
  if (header === "" || secretHeader === "" || secret === "") {
    throw new Error(
      "GEMI_CLIENT_IP_HEADER, GEMI_PROXY_SECRET_HEADER and GEMI_PROXY_SECRET go together: the client-IP header is only believed on a request that carries the proxy's secret. Set all three, or none.",
    );
  }
  if (!HEADER_NAME.test(header)) {
    throw new Error(
      `GEMI_CLIENT_IP_HEADER must be a single header name, e.g. "x-azure-clientip". Got ${JSON.stringify(header)}.`,
    );
  }
  if (!HEADER_NAME.test(secretHeader)) {
    throw new Error(
      `GEMI_PROXY_SECRET_HEADER must be a single header name, e.g. "x-azure-fdid". Got ${JSON.stringify(secretHeader)}.`,
    );
  }
  if (header.toLowerCase() === secretHeader.toLowerCase()) {
    throw new Error("GEMI_CLIENT_IP_HEADER and GEMI_PROXY_SECRET_HEADER name the same header.");
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `GEMI_PROXY_SECRET must be at least ${MIN_SECRET_LENGTH} characters. A guessable one lets any client name its own address.`,
    );
  }
  return { header: header.toLowerCase(), secretHeader: secretHeader.toLowerCase(), secret };
}

/**
 * The address `trust.header` names — its first entry, without a port — on a
 * request whose `trust.secretHeader` matches; `null` when the secret is
 * missing or wrong, or the header is absent or not an IPv4/IPv6 address.
 */
export function trustedHeaderClientIp(
  headers: Headers,
  trust: ClientIpHeaderTrust,
): string | null {
  if (!secretMatches(headers.get(trust.secretHeader), trust.secret)) {
    return null;
  }
  const first = headers.get(trust.header)?.split(",")[0];
  return first === undefined ? null : normalizeIpEntry(first);
}
