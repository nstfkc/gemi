import { describe, expect, test } from "vitest";

import { HttpRequest } from "./HttpRequest";
import { RequestContext } from "./requestContext";
import { SameSiteBounce, SameSiteBounceMiddleware } from "./SameSiteBounceMiddleware";

function run(url: string, init: RequestInit & { kind?: "view" | "api"; user?: object } = {}) {
  const req = new HttpRequest(new Request(url, init), {}, init.kind ?? "view");
  return RequestContext.run(req, async () => {
    if (init.user) RequestContext.getStore().setUser(init.user as any);
    try {
      await new SameSiteBounceMiddleware(req).run();
      return null;
    } catch (error) {
      if (error instanceof SameSiteBounce) return error;
      throw error;
    }
  });
}

const cross = { headers: { "Sec-Fetch-Site": "cross-site" } };

describe("SameSiteBounceMiddleware", () => {
  test("bounces a cross-site page load with no session to the same url, marked", async () => {
    const bounce = await run("https://app.example/return?code=a&state=b", cross);
    expect(bounce?.location).toBe("/return?code=a&state=b&gemi_same_site=1");
    expect(bounce?.payload.view.body).toContain('content="0;url=/return?code=a&amp;state=b&amp;gemi_same_site=1"');
  });

  test("escapes the url in the page", async () => {
    const bounce = await run(`https://app.example/return?x="><script>`, cross);
    expect(bounce?.payload.view.body).not.toContain("<script>");
  });

  test.each([
    ["the marked second hop", "https://app.example/return?gemi_same_site=1", cross],
    ["a request with a session cookie", "https://app.example/return", { headers: { "Sec-Fetch-Site": "cross-site", Cookie: "access_token=t" } }],
    ["a request with a session header", "https://app.example/return", { headers: { "Sec-Fetch-Site": "cross-site", access_token: "t" } }],
    ["a same-origin navigation", "https://app.example/return", { headers: { "Sec-Fetch-Site": "same-origin" } }],
    ["a same-site navigation", "https://app.example/return", { headers: { "Sec-Fetch-Site": "same-site" } }],
    ["a navigation the user started", "https://app.example/return", { headers: { "Sec-Fetch-Site": "none" } }],
    ["a POST", "https://app.example/return", { ...cross, method: "POST" }],
    ["a .json navigation", "https://app.example/return.json", cross],
    ["an api request", "https://app.example/return", { ...cross, kind: "api" as const }],
    ["a request with a user already on the context", "https://app.example/return", { ...cross, user: { id: 1 } }],
  ])("passes %s", async (_name, url, init) => {
    expect(await run(url, init as any)).toBeNull();
  });
});
