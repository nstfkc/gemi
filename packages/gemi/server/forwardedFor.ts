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
 *   unchanged, as before 0.85. Only sound behind a proxy that overwrites
 *   `X-Forwarded-For` (and `X-Real-IP`) rather than appending to it.
 */
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
    client = index >= 0 ? entries[index]! : (entries[0] ?? peer);
  }

  if (client) {
    headers.set("x-forwarded-for", client);
  } else {
    headers.delete("x-forwarded-for");
  }
}
