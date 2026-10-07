import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { BlockedAddressError } from "../safeFetch/errors";
import { Robots, RobotsTxt } from "./index";

describe("Robots writing", () => {
  test("groups, rules, crawl delay and sitemaps", async () => {
    const response = Robots.response({
      rules: [
        { userAgent: "*", disallow: ["/admin", "/api/"], allow: "/admin/public" },
        { userAgent: ["GPTBot", "CCBot"], disallow: "/" },
        { userAgent: "Bingbot", crawlDelay: 5 },
      ],
      sitemaps: ["https://example.com/sitemap.xml"],
    });
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(
      [
        "User-agent: *\nAllow: /admin/public\nDisallow: /admin\nDisallow: /api/\n",
        "User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n",
        "User-agent: Bingbot\nDisallow:\nCrawl-delay: 5\n",
        "Sitemap: https://example.com/sitemap.xml\n",
      ].join("\n"),
    );
  });

  test("refuses line breaks, relative paths and relative sitemaps", () => {
    expect(() => Robots.text({ rules: [{ userAgent: "*", disallow: "/a\nAllow: /" }] })).toThrow(
      /line break/,
    );
    expect(() => Robots.text({ rules: [{ userAgent: "*\r\nDisallow: /", allow: "/" }] })).toThrow(
      /line break/,
    );
    expect(() => Robots.text({ rules: [{ userAgent: "*", disallow: "admin" }] })).toThrow(
      /start with/,
    );
    expect(() => Robots.text({ sitemaps: ["/sitemap.xml"] })).toThrow(/absolute/);
    expect(() => Robots.text({ rules: [{ userAgent: [] }] })).toThrow(/userAgent/);
  });

  test("what it writes parses back to the same answers", () => {
    const robots = Robots.parse(
      Robots.text({
        rules: [{ userAgent: "*", disallow: "/admin", allow: "/admin/public" }],
        sitemaps: ["https://example.com/sitemap.xml"],
      }),
    );
    expect(robots.isAllowed("/admin/x")).toBe(false);
    expect(robots.isAllowed("/admin/public/x")).toBe(true);
    expect(robots.isAllowed("/")).toBe(true);
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });
});

describe("Robots.parse", () => {
  const text = `﻿# comment
User-agent: *
Disallow: /private   # trailing comment
Allow: /private/ok
Disallow: /*.pdf$
Disallow: /search*q=
Crawl-delay: 2

user-agent: Googlebot
user-agent: Bingbot
disallow: /no-google
allow: /

USER-AGENT: BadBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
Sitemap: /relative.xml
Sitemap: not a url
`;
  const robots = Robots.parse(text, { url: "https://example.com/robots.txt" });

  test("groups and sitemaps", () => {
    expect(robots.groups.map((group) => group.userAgents)).toEqual([
      ["*"],
      ["googlebot", "bingbot"],
      ["badbot"],
    ]);
    expect(robots.sitemaps).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/relative.xml",
    ]);
  });

  test("longest match wins, allow wins a tie", () => {
    expect(robots.isAllowed("/private")).toBe(false);
    expect(robots.isAllowed("/private/ok/page")).toBe(true);
    expect(robots.isAllowed("/public")).toBe(true);
    const tie = Robots.parse("User-agent: *\nDisallow: /page\nAllow: /page\n");
    expect(tie.isAllowed("/page")).toBe(true);
  });

  test("wildcards and $", () => {
    expect(robots.isAllowed("/docs/file.pdf")).toBe(false);
    expect(robots.isAllowed("/docs/file.pdf?download=1")).toBe(true);
    expect(robots.isAllowed("/search?x=1&q=a")).toBe(false);
    expect(robots.isAllowed("/search")).toBe(true);
  });

  test("full URLs are matched by path and query", () => {
    expect(robots.isAllowed("https://example.com/private/x")).toBe(false);
    expect(robots.isAllowed(new URL("https://example.com/search?q=1"))).toBe(false);
  });

  test("user agents: product token, case-insensitive, else the * group", () => {
    expect(robots.isAllowed("/no-google", "Googlebot")).toBe(false);
    expect(robots.isAllowed("/no-google", "googlebot/2.1")).toBe(false);
    expect(robots.isAllowed("/private", "Googlebot")).toBe(true);
    expect(robots.isAllowed("/anything", "BadBot")).toBe(false);
    expect(robots.isAllowed("/no-google", "OtherBot")).toBe(true);
    expect(robots.isAllowed("/private", "OtherBot")).toBe(false);
  });

  test("robots.txt itself is always allowed", () => {
    expect(robots.isAllowed("/robots.txt", "BadBot")).toBe(true);
  });

  test("crawl delay", () => {
    expect(robots.crawlDelay()).toBe(2);
    expect(robots.crawlDelay("Googlebot")).toBeNull();
  });

  test("percent-encoding is compared as octets", () => {
    const encoded = Robots.parse("User-agent: *\nDisallow: /ü\nDisallow: /a%2fb\n");
    expect(encoded.isAllowed("/%C3%BC")).toBe(false);
    expect(encoded.isAllowed("/ü/x")).toBe(false);
    expect(encoded.isAllowed("/a%2Fb")).toBe(false);
  });

  test("an empty Disallow disallows nothing, rules before any user-agent are ignored", () => {
    const empty = Robots.parse("Disallow: /\nUser-agent: *\nDisallow:\n");
    expect(empty.isAllowed("/x")).toBe(true);
  });

  test("an empty file allows everything", () => {
    expect(Robots.parse("").isAllowed("/x", "Any")).toBe(true);
  });

  test("a pathological pattern doesn't backtrack exponentially", () => {
    const evil = Robots.parse(`User-agent: *\nDisallow: /${"*a".repeat(200)}$\n`);
    const started = performance.now();
    expect(evil.isAllowed(`/${"a".repeat(5000)}b`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("unavailable allows everything, unreachable disallows everything", () => {
    expect(new RobotsTxt([], [], "unavailable").isAllowed("/x")).toBe(true);
    expect(new RobotsTxt([], [], "unreachable").isAllowed("/x")).toBe(false);
    expect(new RobotsTxt([], [], "unreachable").isAllowed("/robots.txt")).toBe(true);
  });
});

let server: ReturnType<typeof Bun.serve>;
let port: number;
let answer: () => Response = () => new Response("");

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/moved") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://elsewhere.test/robots.txt" },
        });
      }
      return url.pathname === "/robots.txt" ? answer() : new Response("nope", { status: 404 });
    },
  });
  port = server.port!;
});

afterAll(() => {
  server.stop(true);
});

const options = {
  resolve: async () => ["127.0.0.1"],
  allowPrivate: ["127.0.0.1/32"],
  ports: "any" as const,
};

describe("Robots.fetch", () => {
  test("fetches /robots.txt of the site and resolves relative sitemaps", async () => {
    answer = () => new Response("User-agent: *\nDisallow: /admin\nSitemap: /sitemap.xml\n");
    const robots = await Robots.fetch(`http://site.test:${port}/some/page?x=1`, options);
    expect(robots.status).toBe("parsed");
    expect(robots.isAllowed("/admin")).toBe(false);
    expect(robots.sitemaps).toEqual([`http://site.test:${port}/sitemap.xml`]);
  });

  test("a 404 allows everything; a 5xx or 429 disallows everything", async () => {
    answer = () => new Response("Disallow: /", { status: 404 });
    const missing = await Robots.fetch(`http://site.test:${port}`, options);
    expect(missing.status).toBe("unavailable");
    expect(missing.isAllowed("/x")).toBe(true);

    answer = () => new Response("oops", { status: 503 });
    const down = await Robots.fetch(`http://site.test:${port}`, options);
    expect(down.status).toBe("unreachable");
    expect(down.isAllowed("/x")).toBe(false);

    answer = () => new Response("slow down", { status: 429 });
    expect((await Robots.fetch(`http://site.test:${port}`, options)).status).toBe("unreachable");
  });

  test("reads up to maxSize and drops the cut-off line", async () => {
    const head = "User-agent: *\nDisallow: /a\n";
    answer = () =>
      new Response(`${head}Disallow: /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n${"#".repeat(10_000)}`);
    const robots = await Robots.fetch(`http://site.test:${port}`, {
      ...options,
      maxSize: head.length + 10,
    });
    expect(robots.isAllowed("/a")).toBe(false);
    // "Disallow: /b…" was cut to "Disallow: " + a few characters, so it must not apply.
    expect(robots.groups[0].rules).toEqual([{ type: "disallow", path: "/a" }]);
  });

  test("a large Content-Length is still read up to maxSize", async () => {
    answer = () => new Response(`User-agent: *\nDisallow: /a\n${"#".repeat(2_000_000)}`);
    const robots = await Robots.fetch(`http://site.test:${port}`, options);
    expect(robots.isAllowed("/a")).toBe(false);
  });

  test("goes through safeFetch: a private address is refused", async () => {
    await expect(Robots.fetch(`http://127.0.0.1:${port}`, { ports: "any" })).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });
});
