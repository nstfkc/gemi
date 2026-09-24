import { describe, expect, test } from "vitest";

import { domainUrl, isAbsoluteUrl } from "./domainUrl";

/**
 * The URL builder behind `useDomain().url` and `Url.forDomain`: which host it
 * points at, and what it keeps from the origin the caller is on.
 */

const base = { root: "gemi.dev", origin: "http://acme.gemi.dev:5173" };

describe("domainUrl target", () => {
  test("a subdomain hangs off the root, keeping the origin's protocol and port", () => {
    expect(domainUrl(base, { subdomain: "admin" }, "/users/7")).toBe(
      "http://admin.gemi.dev:5173/users/7",
    );
  });

  test("no subdomain is the apex", () => {
    expect(domainUrl(base, {}, "/pricing")).toBe("http://gemi.dev:5173/pricing");
    expect(domainUrl(base, { subdomain: null }, "/pricing")).toBe("http://gemi.dev:5173/pricing");
  });

  // A custom domain is a whole hostname, not a label under the root: `host`
  // has to replace the hostname outright, or a tenant on `app.acme.com` would
  // be linked to `app.acme.com.gemi.dev`.
  test("`host` names the whole hostname, off the root entirely", () => {
    expect(domainUrl(base, { host: "app.acme.com" }, "/users/7")).toBe(
      "http://app.acme.com:5173/users/7",
    );
    expect(
      domainUrl({ root: "gemi.dev", origin: "https://acme.gemi.dev" }, { host: "app.acme.com" }),
    ).toBe("https://app.acme.com/");
  });

  test("`host` wins over `subdomain`, as documented", () => {
    expect(domainUrl(base, { host: "app.acme.com", subdomain: "admin" }, "/x")).toBe(
      "http://app.acme.com:5173/x",
    );
  });

  test("a path without a leading slash is still a path from the root", () => {
    expect(domainUrl(base, { subdomain: "admin" }, "users/7")).toBe(
      "http://admin.gemi.dev:5173/users/7",
    );
  });

  test("a host may carry its own port, which wins over the caller's", () => {
    expect(domainUrl(base, { host: "app.acme.com:8080" }, "/users/7")).toBe(
      "http://app.acme.com:8080/users/7",
    );
  });

  /**
   * `url.hostname = x` is a WHATWG setter and drops a value it cannot parse
   * *silently*, which returned a link to the host the caller was already on —
   * a wrong-tenant link that looks right, from nothing worse than a stored
   * custom domain someone typed a scheme into.
   */
  test("a host that is more than a host is an error, not a link to the current one", () => {
    for (const host of [
      "https://app.acme.com",
      "u:p@app.acme.com",
      "app.acme.com/evil",
      "app acme.com",
    ]) {
      expect(() => domainUrl(base, { host }, "/users/7")).toThrow(/is not a hostname/);
    }
  });

  test("no host at all is still the apex", () => {
    expect(domainUrl(base, { host: "" }, "/users/7")).toBe("http://gemi.dev:5173/users/7");
  });
});

describe("isAbsoluteUrl", () => {
  test("only an http(s) URL is absolute; a path never is", () => {
    expect(isAbsoluteUrl("http://admin.gemi.dev/users")).toBe(true);
    expect(isAbsoluteUrl("HTTPS://admin.gemi.dev/users")).toBe(true);
    expect(isAbsoluteUrl("/users")).toBe(false);
    expect(isAbsoluteUrl("//admin.gemi.dev/users")).toBe(false);
  });
});
