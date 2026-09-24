import { describe, expect, test } from "vitest";

import { Cookie } from "../facades/Cookie";
import { HttpRequest } from "./HttpRequest";
import { RequestContext } from "./requestContext";

/**
 * A browser matches a deletion against a stored cookie by name *and* by
 * `Domain` and `Path`. A deletion that drops either does not remove anything:
 * it stores an expired second cookie under the default scope and leaves the
 * original — a session cookie written for `Domain=gemi.dev` — in place. That
 * is why `deleteCookie` carries the attributes through, and it is the only
 * reason it exists rather than callers writing an empty value.
 */
function written(fn: () => void): string[] {
  return RequestContext.run(new HttpRequest(new Request("http://acme.gemi.dev/")), () => {
    fn();
    return Array.from(RequestContext.getStore().cookies);
  });
}

describe("deleting a cookie", () => {
  test("repeats the `Domain` and `Path` the cookie was written with", () => {
    const [cookie] = written(() =>
      Cookie.delete("access_token", { domain: "gemi.dev", path: "/app" }),
    );

    expect(cookie).toContain("Domain=gemi.dev");
    expect(cookie).toContain("Path=/app");
    expect(cookie).toContain("access_token=");
    expect(cookie).toContain("Max-Age=-1");
  });

  test("without attributes it clears the host-scoped cookie at the root", () => {
    const [cookie] = written(() => Cookie.delete("access_token"));

    expect(cookie).not.toContain("Domain=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=-1");
  });
});
