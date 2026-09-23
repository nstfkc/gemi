import { describe, expect, test, vi } from "vitest";

import { DomainResolver, assertValidDomainsConfig, normalizeHost } from "./DomainResolver";
import type { DomainsConfig } from "./config";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

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
  test("is the request's own origin unless the proxy is trusted", () => {
    const forwarded = req("http://127.0.0.1:5173/", {
      "x-forwarded-host": "acme.example.com",
      "x-forwarded-proto": "https",
    });
    expect(resolver().publicOrigin(forwarded)).toBe("http://127.0.0.1:5173");
    expect(resolver({ trustProxy: true }).publicOrigin(forwarded)).toBe("https://acme.example.com");
  });
});

describe("assertValidDomainsConfig", () => {
  const cases: Array<[string, DomainsConfig, RegExp]> = [
    ["an empty root", { root: "" }, /must be a hostname/],
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
  ];

  for (const [name, config, message] of cases) {
    test(`refuses ${name}`, () => {
      expect(() => assertValidDomainsConfig(config)).toThrow(message);
    });
  }
});
