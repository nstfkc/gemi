import { describe, expect, test, vi } from "vitest";

import { DomainResolver, assertValidDomainsConfig, normalizeHost } from "./DomainResolver";
import type { DomainsConfig } from "./config";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

const PROXY_SECRET = "proxy-secret-long-enough";

function resolver(overrides: Partial<DomainsConfig> = {}) {
  return new DomainResolver({
    root: "example.com",
    groups: [{ subdomain: "admin" }, { subdomain: "eu.admin" }, { subdomain: ":tenant" }],
    ...overrides,
  });
}

describe("normalizeHost", () => {
  test("lowercases and drops the port and a trailing dot", () => {
    expect(normalizeHost("Acme.Example.com:5173")).toBe("acme.example.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
  });

  test("is null for nothing", () => {
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost(null)).toBeNull();
  });
});

describe("DomainResolver.resolve", () => {
  test("the root is the root group, whatever the port", async () => {
    expect(await resolver().resolve(req("http://example.com:5173/x"))).toEqual({
      host: "example.com",
      group: "",
      params: {},
      custom: false,
    });
  });

  test("a fixed subdomain beats the param one", async () => {
    const domain = await resolver().resolve(req("http://admin.example.com/"));
    expect(domain).toMatchObject({ group: "admin", params: {} });
  });

  test("a fixed subdomain can span labels", async () => {
    const domain = await resolver().resolve(req("http://eu.admin.example.com/"));
    expect(domain).toMatchObject({ group: "eu.admin" });
  });

  test("a param subdomain hands over its label", async () => {
    const domain = await resolver().resolve(req("http://acme.example.com/"));
    expect(domain).toEqual({
      host: "acme.example.com",
      group: ":tenant",
      params: { tenant: "acme" },
      custom: false,
    });
  });

  test("a param subdomain matches one label only", async () => {
    expect(await resolver().resolve(req("http://a.b.example.com/"))).toBeNull();
  });

  test("`exists` returning false turns the host away", async () => {
    const exists = vi.fn(({ tenant }: Record<string, string>) => tenant === "acme");
    const r = resolver({ groups: [{ subdomain: ":tenant", exists }] });
    expect(await r.resolve(req("http://acme.example.com/"))).not.toBeNull();
    expect(await r.resolve(req("http://nope.example.com/"))).toBeNull();
    expect(exists).toHaveBeenCalledTimes(2);
  });

  test("a host outside the root is unknown without `custom`", async () => {
    expect(await resolver().resolve(req("http://acme.com/"))).toBeNull();
    expect(await resolver().resolve(req("http://notexample.com/"))).toBeNull();
  });

  test("a custom domain is served as its target group", async () => {
    const r = resolver({
      custom: {
        group: ":tenant",
        resolve: (host) => (host === "app.acme.com" ? { tenant: "acme" } : null),
      },
    });
    expect(await r.resolve(req("http://app.acme.com/"))).toEqual({
      host: "app.acme.com",
      group: ":tenant",
      params: { tenant: "acme" },
      custom: true,
    });
    expect(await r.resolve(req("http://other.com/"))).toBeNull();
  });

  test("an unresolved custom domain falls back when a fallback is declared", async () => {
    const r = resolver({
      custom: { group: ":tenant", resolve: () => null, fallback: {} },
    });
    expect(await r.resolve(req("http://other.com/"))).toMatchObject({
      group: "*",
      custom: true,
    });
    // A subdomain nothing matches is not a custom domain, fallback or not.
    expect(await r.resolve(req("http://a.b.example.com/"))).toBeNull();
  });

  test("custom answers are cached, misses included, until forgotten", async () => {
    const resolve = vi.fn((host: string) => (host === "app.acme.com" ? { tenant: "acme" } : null));
    const r = resolver({ custom: { group: ":tenant", resolve } });
    await r.resolve(req("http://app.acme.com/"));
    await r.resolve(req("http://app.acme.com/other"));
    await r.resolve(req("http://miss.com/"));
    await r.resolve(req("http://miss.com/"));
    expect(resolve).toHaveBeenCalledTimes(2);
    r.forget("app.acme.com");
    await r.resolve(req("http://app.acme.com/"));
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  test("a zero TTL does not cache", async () => {
    const resolve = vi.fn(() => ({ tenant: "acme" }));
    const r = resolver({ custom: { group: ":tenant", resolve, cacheTtlMs: 0 } });
    await r.resolve(req("http://app.acme.com/"));
    await r.resolve(req("http://app.acme.com/"));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test("X-Forwarded-Host counts only behind a trusted proxy", async () => {
    const forwarded = req("http://127.0.0.1:5173/", { "x-forwarded-host": "acme.example.com" });
    expect(await resolver().resolve(forwarded)).toBeNull();
    expect(await resolver({ trustProxy: true }).resolve(forwarded)).toMatchObject({
      params: { tenant: "acme" },
    });
  });
});

describe("DomainResolver.allows", () => {
  test("approves what resolves in its own right, never the fallback", async () => {
    const r = resolver({
      custom: {
        group: ":tenant",
        resolve: (host) => (host === "app.acme.com" ? { tenant: "acme" } : null),
        fallback: {},
      },
    });
    const probe = req("http://localhost/");
    expect(await r.allows("example.com", probe)).toBe(true);
    expect(await r.allows("admin.example.com", probe)).toBe(true);
    expect(await r.allows("acme.example.com", probe)).toBe(true);
    expect(await r.allows("app.acme.com", probe)).toBe(true);
    expect(await r.allows("evil.com", probe)).toBe(false);
    expect(await r.allows("", probe)).toBe(false);
  });
});

describe("DomainResolver.publicOrigin", () => {
  test("takes the host from the proxy only when it is trusted", () => {
    const forwarded = req("http://127.0.0.1:5173/", {
      "x-forwarded-host": "acme.example.com",
      "x-forwarded-proto": "https",
    });
    expect(resolver().publicOrigin(forwarded)).toBe("https://127.0.0.1:5173");
    expect(resolver({ trustProxy: true }).publicOrigin(forwarded)).toBe("https://acme.example.com");
  });

  // TLS is nearly always terminated by a proxy that reaches the app over plain
  // http, and a forged scheme only spoils the forger's own links — so unlike
  // the host, the scheme is read whether or not the proxy is trusted.
  test("takes the scheme from the proxy either way", () => {
    const behindTls = req("http://127.0.0.1:5173/", { "x-forwarded-proto": "https" });
    expect(resolver().publicOrigin(behindTls)).toBe("https://127.0.0.1:5173");
    expect(resolver({ trustProxy: true }).publicOrigin(behindTls)).toBe("https://127.0.0.1:5173");
  });

  test("keeps anything but http and https out of the scheme", () => {
    const hostile = req("http://127.0.0.1:5173/", { "x-forwarded-proto": "javascript" });
    expect(resolver().publicOrigin(hostile)).toBe("http://127.0.0.1:5173");
  });

  // The header is attacker-supplied text, and it is spliced into an origin that
  // every cross-host link on the response is built from.
  test("strips userinfo from a trusted proxy's host, and keeps the port", () => {
    const trusted = resolver({ trustProxy: true });
    expect(
      trusted.publicOrigin(
        req("http://127.0.0.1:5173/", { "x-forwarded-host": "acme.example.com:8443" }),
      ),
    ).toBe("http://acme.example.com:8443");
    expect(
      trusted.publicOrigin(
        req("http://127.0.0.1:5173/", { "x-forwarded-host": "user:pass@acme.example.com" }),
      ),
    ).toBe("http://acme.example.com");
  });

  test("falls back to the request's host when the forwarded one is unparseable", () => {
    expect(
      resolver({ trustProxy: true }).publicOrigin(
        req("http://127.0.0.1:5173/", { "x-forwarded-host": "]" }),
      ),
    ).toBe("http://127.0.0.1:5173");
  });
});

describe("assertValidDomainsConfig", () => {
  const cases: Array<[string, DomainsConfig, RegExp]> = [
    ["an empty root", { root: "" }, /must be a bare hostname/],
    [
      "a subdomain declared twice",
      { root: "example.com", groups: [{ subdomain: "admin" }, { subdomain: "admin" }] },
      /twice/,
    ],
    [
      "two param subdomains",
      { root: "example.com", groups: [{ subdomain: ":a" }, { subdomain: ":b" }] },
      /two param subdomains/,
    ],
    [
      "a multi-label param",
      { root: "example.com", groups: [{ subdomain: ":a.b" }] },
      /not a valid param subdomain/,
    ],
    [
      "a malformed label",
      { root: "example.com", groups: [{ subdomain: "bad_label" }] },
      /not a valid subdomain/,
    ],
    [
      "`exists` on a fixed subdomain",
      { root: "example.com", groups: [{ subdomain: "admin", exists: () => true }] },
      /only applies to a `:param`/,
    ],
    [
      "a custom target naming no group",
      { root: "example.com", custom: { group: ":tenant", resolve: () => null } },
      /no group declares/,
    ],
    // A root `normalizeHost` parses but that matches nothing: both of these
    // booted cleanly and then answered "Unknown host" to every request.
    ["a root with a scheme", { root: "https://example.com" }, /must be a bare hostname/],
    ["a root with a leading dot", { root: ".example.com" }, /must be a bare hostname/],
    ["a root with an underscore", { root: "ex_ample.com" }, /must be a bare hostname/],
    ["a root with a port", { root: "example.com:8080" }, /must be a bare hostname/],
    [
      "a negative cache TTL",
      { root: "example.com", custom: { group: "", resolve: () => null, cacheTtlMs: -1 } },
      /cannot be negative/,
    ],
    [
      "a guessable ask secret",
      { root: "example.com", ask: { secret: "short" } },
      /at least 16 characters/,
    ],
    // With `ask` on and no `exists`, every label under the root is approved for
    // a certificate, which spends the CA's rate limit for the whole domain.
    [
      "`ask` with a param group that cannot say which tenants are real",
      {
        root: "example.com",
        groups: [{ subdomain: ":tenant" }],
        ask: { secret: "ask-secret-long-enough" },
      },
      /needs an `exists`/,
    ],
    [
      "a host header that is not a header name",
      { root: "example.com", trustProxy: { hostHeader: "x kyte host" } },
      /must be a single header name/,
    ],
    [
      "a list of host headers",
      {
        root: "example.com",
        trustProxy: { hostHeader: ["x-kyte-host", "x-forwarded-host"] as unknown as string },
      },
      /must be a single header name/,
    ],
    [
      "a secret header that is not a header name",
      {
        root: "example.com",
        trustProxy: { hostHeader: "x-kyte-host", secret: { header: "", value: PROXY_SECRET } },
      },
      /must be a header name/,
    ],
    [
      "a guessable proxy secret",
      {
        root: "example.com",
        trustProxy: {
          hostHeader: "x-kyte-host",
          secret: { header: "x-kyte-secret", value: "short" },
        },
      },
      /at least 16 characters/,
    ],
    // An unset environment variable, e.g. `value: process.env.PROXY_SECRET`.
    [
      "a proxy secret that is not set",
      {
        root: "example.com",
        trustProxy: {
          hostHeader: "x-kyte-host",
          secret: { header: "x-kyte-secret", value: undefined as unknown as string },
        },
      },
      /at least 16 characters/,
    ],
    [
      "a secret carried in the host header itself",
      {
        root: "example.com",
        trustProxy: {
          hostHeader: "X-Kyte-Host",
          secret: { header: "x-kyte-host", value: PROXY_SECRET },
        },
      },
      /needs a header of its own/,
    ],
    [
      "a secret in `X-Forwarded-Host` when that is the host header by default",
      {
        root: "example.com",
        trustProxy: { secret: { header: "x-forwarded-host", value: PROXY_SECRET } },
      },
      /needs a header of its own/,
    ],
  ];

  for (const [name, config, message] of cases) {
    test(`refuses ${name}`, () => {
      expect(() => assertValidDomainsConfig(config)).toThrow(message);
    });
  }

  test("accepts `ask` once the param group has an `exists`", () => {
    expect(() =>
      assertValidDomainsConfig({
        root: "example.com",
        groups: [{ subdomain: ":tenant", exists: () => true }],
        ask: { secret: "ask-secret-long-enough" },
      }),
    ).not.toThrow();
  });

  test("accepts a root with several labels and a digit", () => {
    expect(() => assertValidDomainsConfig({ root: "app.gemi-2.example.com" })).not.toThrow();
  });
});

describe("DomainResolver custom-domain cache", () => {
  const withResolve = (
    resolve: (
      host: string,
    ) => Record<string, string> | null | Promise<Record<string, string> | null>,
    cacheTtlMs?: number,
  ) =>
    new DomainResolver({
      root: "example.com",
      groups: [{ subdomain: ":tenant" }],
      custom: { group: ":tenant", resolve, cacheTtlMs },
    });

  const hit = (r: DomainResolver, host: string) => r.resolve(req(`http://${host}/`));

  test("reuses an answer until the TTL runs out, then asks again", async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn(() => ({ tenant: "acme" }));
      const r = withResolve(resolve, 60_000);

      await hit(r, "app.acme.com");
      await hit(r, "app.acme.com");
      expect(resolve).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(59_000);
      await hit(r, "app.acme.com");
      expect(resolve).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      await hit(r, "app.acme.com");
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // A burst of unknown hosts used to evict every real customer, because the
  // eviction went by insertion rather than by use.
  test("evicts the least recently used, not the oldest", async () => {
    const resolve = vi.fn((host: string) => ({ tenant: host }));
    const r = withResolve(resolve);

    await hit(r, "first.example.org");
    await hit(r, "second.example.org");
    // Touch the older one, so of the two it is the least recently *inserted*
    // and the most recently *used* — the case the two policies disagree on.
    await hit(r, "first.example.org");
    expect(resolve).toHaveBeenCalledTimes(2);

    // Enough to overflow the 10 000-entry cache by exactly one, so exactly one
    // of the pair above is evicted and which one is the whole question.
    for (let i = 0; i < 9_999; i++) await hit(r, `flood${i}.example.org`);
    const evictions = resolve.mock.calls.length;

    await hit(r, "first.example.org");
    expect(resolve).toHaveBeenCalledTimes(evictions);
    await hit(r, "second.example.org");
    expect(resolve).toHaveBeenCalledTimes(evictions + 1);
  });

  test("a cold host that many requests arrive for at once is resolved once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const resolve = vi.fn(async () => {
      await gate;
      return { tenant: "acme" };
    });
    const r = withResolve(resolve);

    const all = Promise.all(Array.from({ length: 100 }, () => hit(r, "app.acme.com")));
    release();
    const results = await all;

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(results.every((d) => d?.params.tenant === "acme")).toBe(true);
  });

  test("a resolver that throws caches nothing and is retried", async () => {
    const resolve = vi.fn(() => {
      throw new Error("database is down");
    });
    const r = withResolve(resolve);

    await expect(hit(r, "app.acme.com")).rejects.toThrow("database is down");
    await expect(hit(r, "app.acme.com")).rejects.toThrow("database is down");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test("forget() drops one host, or every host, and normalizes what it is given", async () => {
    const resolve = vi.fn(() => ({ tenant: "acme" }));
    const r = withResolve(resolve);

    await hit(r, "app.acme.com");
    await hit(r, "other.example.org");
    expect(resolve).toHaveBeenCalledTimes(2);

    // Mixed case and a port, as a caller would have it from a database row.
    r.forget("APP.acme.com:443");
    await hit(r, "app.acme.com");
    await hit(r, "other.example.org");
    expect(resolve).toHaveBeenCalledTimes(3);

    r.forget();
    await hit(r, "app.acme.com");
    await hit(r, "other.example.org");
    expect(resolve).toHaveBeenCalledTimes(5);
  });
});

/**
 * `trustProxy` naming its own header, as behind a CDN that terminates the
 * customer's TLS in front of a platform that owns `X-Forwarded-Host`: the
 * customer's host arrives only in the header the CDN adds.
 */
describe("trustProxy with a host header of its own", () => {
  // What the app sees behind Cloudflare for SaaS and Railway: `Host` and
  // `X-Forwarded-Host` both name the app's own domain.
  const behindCdn = (headers: Record<string, string> = {}) =>
    req("http://kyte.up.railway.app/", {
      "x-forwarded-host": "kyte.up.railway.app",
      "x-forwarded-proto": "https",
      ...headers,
    });
  const customResolve = (host: string) => (host === "app.acme.com" ? { tenant: "acme" } : null);
  const custom = { group: ":tenant", resolve: customResolve, cacheTtlMs: 0 };
  const withHeader = (extra: Partial<DomainsConfig> = {}) =>
    resolver({ trustProxy: { hostHeader: "x-kyte-host" }, custom, ...extra });
  const withSecret = (extra: Partial<DomainsConfig> = {}) =>
    resolver({
      trustProxy: {
        hostHeader: "x-kyte-host",
        secret: { header: "x-kyte-proxy-secret", value: PROXY_SECRET },
      },
      custom,
      ...extra,
    });

  test("routes by the named header", async () => {
    const r = withHeader();
    const domain = await r.resolve(behindCdn({ "x-kyte-host": "app.acme.com" }));
    expect(domain).toEqual({
      host: "app.acme.com",
      group: ":tenant",
      params: { tenant: "acme" },
      custom: true,
    });
    expect(r.publicOrigin(behindCdn({ "x-kyte-host": "app.acme.com" }))).toBe(
      "https://app.acme.com",
    );
  });

  test("the header is matched whatever its case in the config", async () => {
    const r = resolver({ trustProxy: { hostHeader: "X-Kyte-Host" }, custom });
    expect(await r.resolve(behindCdn({ "x-kyte-host": "app.acme.com" }))).toMatchObject({
      params: { tenant: "acme" },
    });
  });

  test("is ignored without trustProxy", async () => {
    const r = resolver({ custom });
    const spoofed = req("http://acme.example.com/", { "x-kyte-host": "app.acme.com" });
    expect(await r.resolve(spoofed)).toMatchObject({ host: "acme.example.com", custom: false });
    expect(r.publicOrigin(spoofed)).toBe("http://acme.example.com");
  });

  // The named header replaces `X-Forwarded-Host` rather than adding to it: the
  // platform writes that one, and trusting both would route by whichever the
  // client managed to get through.
  test("wins over X-Forwarded-Host, which is no longer read at all", async () => {
    const r = withHeader();
    expect(
      await r.resolve(
        req("http://example.com/", {
          "x-kyte-host": "app.acme.com",
          "x-forwarded-host": "admin.example.com",
        }),
      ),
    ).toMatchObject({ host: "app.acme.com" });
    const onlyForwarded = req("http://example.com/", { "x-forwarded-host": "admin.example.com" });
    expect(await r.resolve(onlyForwarded)).toMatchObject({ host: "example.com", group: "" });
    expect(r.publicOrigin(onlyForwarded)).toBe("http://example.com");
  });

  test("`true` still means X-Forwarded-Host, and ignores any other header", async () => {
    const r = resolver({ trustProxy: true, custom });
    expect(
      await r.resolve(
        req("http://example.com/", {
          "x-forwarded-host": "admin.example.com",
          "x-kyte-host": "app.acme.com",
        }),
      ),
    ).toMatchObject({ host: "admin.example.com", group: "admin" });
  });

  test("an object without `hostHeader` reads X-Forwarded-Host", async () => {
    const r = resolver({ trustProxy: {}, custom });
    expect(
      await r.resolve(req("http://example.com/", { "x-forwarded-host": "admin.example.com" })),
    ).toMatchObject({ group: "admin" });
  });

  test("falls back to the request's host when the header is missing or unparseable", async () => {
    const r = withHeader();
    expect(await r.resolve(req("http://admin.example.com/"))).toMatchObject({ group: "admin" });
    expect(await r.resolve(req("http://admin.example.com/", { "x-kyte-host": "]" }))).toMatchObject(
      { group: "admin" },
    );
    expect(r.publicOrigin(req("http://admin.example.com:8080/", { "x-kyte-host": "" }))).toBe(
      "http://admin.example.com:8080",
    );
  });

  test("with the secret, the header is trusted", async () => {
    const r = withSecret();
    const proxied = behindCdn({
      "x-kyte-host": "app.acme.com",
      "x-kyte-proxy-secret": PROXY_SECRET,
    });
    expect(await r.resolve(proxied)).toMatchObject({ host: "app.acme.com", custom: true });
    expect(r.publicOrigin(proxied)).toBe("https://app.acme.com");
  });

  // Someone who reaches the origin directly, around the CDN, names any host
  // they like. Without the secret they are served by the host they connected
  // to — one they could have sent anyway — never the one they claim.
  test("a spoofed header without the secret is ignored", async () => {
    const r = withSecret();
    const spoofed = req("http://acme.example.com/", { "x-kyte-host": "app.acme.com" });
    expect(await r.resolve(spoofed)).toMatchObject({
      host: "acme.example.com",
      params: { tenant: "acme" },
      custom: false,
    });
    expect(r.publicOrigin(spoofed)).toBe("http://acme.example.com");
    expect(await r.resolve(behindCdn({ "x-kyte-host": "app.acme.com" }))).toBeNull();
  });

  test("a wrong secret is the same as none", async () => {
    const r = withSecret();
    const wrong = [
      `${PROXY_SECRET}x`,
      PROXY_SECRET.slice(0, -1),
      PROXY_SECRET.toUpperCase(),
      "",
      `${PROXY_SECRET}, ${PROXY_SECRET}`,
    ];
    for (const secret of wrong) {
      const spoofed = req("http://admin.example.com/", {
        "x-kyte-host": "app.acme.com",
        "x-kyte-proxy-secret": secret,
      });
      expect(await r.resolve(spoofed)).toMatchObject({ host: "admin.example.com" });
      expect(r.publicOrigin(spoofed)).toBe("http://admin.example.com");
    }
  });

  test("the secret in a different header is the same as none", async () => {
    const spoofed = req("http://admin.example.com/", {
      "x-kyte-host": "app.acme.com",
      "x-forwarded-host": PROXY_SECRET,
      "x-kyte-secret": PROXY_SECRET,
    });
    expect(await withSecret().resolve(spoofed)).toMatchObject({ host: "admin.example.com" });
  });

  test("the secret can gate X-Forwarded-Host too", async () => {
    const r = resolver({
      trustProxy: { secret: { header: "x-proxy-secret", value: PROXY_SECRET } },
    });
    const forwarded = { "x-forwarded-host": "admin.example.com" };
    expect(await r.resolve(req("http://example.com/", forwarded))).toMatchObject({ group: "" });
    expect(
      await r.resolve(req("http://example.com/", { ...forwarded, "x-proxy-secret": PROXY_SECRET })),
    ).toMatchObject({ group: "admin" });
  });

  // The scheme is not gated by `trustProxy` or its secret: a forged one only
  // spoils the forger's own links, and gating it would put every link on an
  // https page behind a TLS-terminating proxy back on http.
  test("X-Forwarded-Proto is read whether or not the host header is trusted", () => {
    const r = withSecret();
    expect(r.publicOrigin(req("http://admin.example.com/", { "x-forwarded-proto": "https" }))).toBe(
      "https://admin.example.com",
    );
    expect(
      r.publicOrigin(
        req("http://admin.example.com/", {
          "x-forwarded-proto": "https",
          "x-kyte-host": "app.acme.com",
          "x-kyte-proxy-secret": "wrong-secret-long-enough",
        }),
      ),
    ).toBe("https://admin.example.com");
    expect(
      r.publicOrigin(
        req("http://admin.example.com/", {
          "x-forwarded-proto": "javascript",
          "x-kyte-host": "app.acme.com",
          "x-kyte-proxy-secret": PROXY_SECRET,
        }),
      ),
    ).toBe("http://app.acme.com");
  });

  test("exposes the secret header so it can be kept from upstreams", () => {
    expect(withSecret().proxySecretHeader).toBe("x-kyte-proxy-secret");
    expect(withHeader().proxySecretHeader).toBeNull();
    expect(resolver({ trustProxy: true }).proxySecretHeader).toBeNull();
  });
});
