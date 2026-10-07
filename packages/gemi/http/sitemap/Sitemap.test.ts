import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { BlockedAddressError, TooLargeError } from "../safeFetch/errors";
import { Sitemap, SitemapError, type SitemapEntry } from "./index";

describe("Sitemap writing", () => {
  test("a urlset with escaped URLs, dates and hreflang alternates", async () => {
    const response = Sitemap.response([
      {
        loc: "https://example.com/a?x=1&y=<2>",
        lastmod: new Date("2026-10-07T12:00:00Z"),
        changefreq: "weekly",
        priority: 0.8,
        alternates: [
          { hrefLang: "en", href: "https://example.com/a" },
          { hrefLang: "tr", href: "https://example.com/tr/ü" },
          { hrefLang: "x-default", href: "https://example.com/a" },
        ],
      },
      { loc: "https://example.com/b c", lastmod: "2026-10-01" },
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const xml = await response.text();
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
        "<url><loc>https://example.com/a?x=1&amp;y=%3C2%3E</loc><lastmod>2026-10-07T12:00:00.000Z</lastmod>" +
        "<changefreq>weekly</changefreq><priority>0.8</priority>" +
        '<xhtml:link rel="alternate" hreflang="en" href="https://example.com/a"/>' +
        '<xhtml:link rel="alternate" hreflang="tr" href="https://example.com/tr/%C3%BC"/>' +
        '<xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/a"/></url>\n' +
        "<url><loc>https://example.com/b%20c</loc><lastmod>2026-10-01</lastmod></url>\n" +
        "</urlset>\n",
    );
  });

  test("an ampersand in a query is escaped once", () => {
    const [xml] = Sitemap.chunk([{ loc: "https://example.com/?a=1&b=2" }]);
    expect(xml).toContain("<loc>https://example.com/?a=1&amp;b=2</loc>");
  });

  test("refuses entries the protocol doesn't allow", () => {
    expect(() => Sitemap.chunk([{ loc: "/relative" }])).toThrow(SitemapError);
    expect(() => Sitemap.chunk([{ loc: "ftp://example.com/" }])).toThrow(/http/);
    expect(() => Sitemap.chunk([{ loc: `https://example.com/${"a".repeat(2100)}` }])).toThrow(
      /2048/,
    );
    expect(() => Sitemap.chunk([{ loc: "https://example.com/", priority: 2 }])).toThrow(/priority/);
    expect(() => Sitemap.chunk([{ loc: "https://example.com/", lastmod: "yesterday" }])).toThrow(
      /W3C/,
    );
    expect(() =>
      Sitemap.chunk([{ loc: "https://example.com/", lastmod: new Date("nope") }]),
    ).toThrow(/invalid/);
    expect(() =>
      Sitemap.chunk([{ loc: "https://example.com/", changefreq: "sometimes" as never }]),
    ).toThrow(/changefreq/);
    expect(() =>
      Sitemap.chunk([
        {
          loc: "https://example.com/",
          alternates: [{ hrefLang: "", href: "https://example.com/" }],
        },
      ]),
    ).toThrow(/hrefLang/);
  });

  test("no entries is an empty urlset", () => {
    const files = Sitemap.chunk([]);
    expect(files).toHaveLength(1);
    expect(Sitemap.parse(files[0])).toEqual({ kind: "urlset", urls: [] });
  });

  const pages = (count: number): SitemapEntry[] =>
    Array.from({ length: count }, (_, i) => ({ loc: `https://example.com/p/${i}` }));

  test("splits at maxUrls", () => {
    const files = Sitemap.chunk(pages(5), { maxUrls: 2 });
    expect(files).toHaveLength(3);
    expect(files.map((file) => (Sitemap.parse(file) as { urls: unknown[] }).urls.length)).toEqual([
      2, 2, 1,
    ]);
  });

  test("splits at the protocol's 50 000 URLs by default", () => {
    const files = Sitemap.chunk(pages(50_001));
    expect(files).toHaveLength(2);
    expect((Sitemap.parse(files[1]) as { urls: unknown[] }).urls).toHaveLength(1);
  });

  test("splits at maxBytes, counting the file as encoded", () => {
    const files = Sitemap.chunk(pages(10), { maxBytes: 400 });
    expect(files.length).toBeGreaterThan(1);
    for (const file of files)
      expect(new TextEncoder().encode(file).byteLength).toBeLessThanOrEqual(400);
    const all = files.flatMap((file) => (Sitemap.parse(file) as { urls: { loc: string }[] }).urls);
    expect(all.map((url) => url.loc)).toEqual(pages(10).map((page) => page.loc));
  });

  test("an entry over maxBytes on its own throws", () => {
    expect(() => Sitemap.chunk(pages(1), { maxBytes: 100 })).toThrow(/alone/);
  });

  test("limits above the protocol's are refused", () => {
    expect(() => Sitemap.chunk([], { maxUrls: 50_001 })).toThrow(RangeError);
    expect(() => Sitemap.chunk([], { maxBytes: Sitemap.MAX_BYTES + 1 })).toThrow(RangeError);
  });

  test("past the limits, the response is an index and `page` picks a file", async () => {
    const options = {
      maxUrls: 2,
      pageUrl: (page: number) => `https://example.com/sitemap.xml?page=${page}`,
    };
    const index = await Sitemap.response(pages(5), options).text();
    expect(Sitemap.parse(index)).toEqual({
      kind: "index",
      sitemaps: [1, 2, 3].map((page) => ({ loc: `https://example.com/sitemap.xml?page=${page}` })),
    });
    expect(index).toContain("<sitemapindex");

    const second = await Sitemap.response(pages(5), { ...options, page: "2" }).text();
    expect(Sitemap.parse(second)).toEqual({
      kind: "urlset",
      urls: [{ loc: "https://example.com/p/2" }, { loc: "https://example.com/p/3" }],
    });
    expect(Sitemap.response(pages(5), { ...options, page: 4 }).status).toBe(404);
    expect(Sitemap.response(pages(5), { ...options, page: "0" }).status).toBe(404);
    expect(Sitemap.response(pages(5), { ...options, page: "1e3" }).status).toBe(404);
    expect(Sitemap.response(pages(1), { ...options, page: "1" }).status).toBe(200);
    expect(Sitemap.response(pages(1), { ...options, page: null }).status).toBe(200);
  });

  test("an index without pageUrl throws instead of guessing URLs", () => {
    expect(() => Sitemap.response(pages(3), { maxUrls: 2 })).toThrow(/pageUrl/);
  });

  test("headers are added", () => {
    const response = Sitemap.response(pages(1), {
      headers: { "cache-control": "public, max-age=3600" },
    });
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("index() writes lastmod", () => {
    const xml = Sitemap.index([{ loc: "https://example.com/s1.xml", lastmod: "2026-10-07" }]);
    expect(xml).toContain(
      "<sitemap><loc>https://example.com/s1.xml</loc><lastmod>2026-10-07</lastmod></sitemap>",
    );
  });
});

describe("Sitemap.parse", () => {
  test("reads urls, alternates, CDATA and entities, and ignores extension elements", () => {
    const xml = `﻿<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE urlset [ <!ENTITY boom "boom"> ]>
<!-- a comment with <url> in it -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc> https://example.com/a?x=1&amp;y=2 </loc>
    <lastmod>2026-10-07</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.5</priority>
    <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/a"/>
    <xhtml:link rel='alternate' hreflang='fr' href='https://example.com/fr/a' />
    <xhtml:link rel="canonical" href="https://example.com/ignored"/>
    <image:image><image:loc>https://example.com/img.png</image:loc></image:image>
  </url>
  <url><loc><![CDATA[https://example.com/b?q=<1>]]></loc></url>
  <url><loc>&boom;</loc></url>
  <url><loc>javascript:alert(1)</loc></url>
  <url><lastmod>2026-01-01</lastmod></url>
</urlset>`;
    expect(Sitemap.parse(xml)).toEqual({
      kind: "urlset",
      urls: [
        {
          loc: "https://example.com/a?x=1&y=2",
          lastmod: "2026-10-07",
          changefreq: "daily",
          priority: 0.5,
          alternates: [
            { hrefLang: "de", href: "https://example.com/de/a" },
            { hrefLang: "fr", href: "https://example.com/fr/a" },
          ],
        },
        { loc: "https://example.com/b?q=%3C1%3E" },
      ],
    });
  });

  test("round-trips what it writes", () => {
    const entries: SitemapEntry[] = [
      {
        loc: "https://example.com/a",
        lastmod: "2026-10-07",
        alternates: [{ hrefLang: "en-US", href: "https://example.com/a" }],
      },
    ];
    const [xml] = Sitemap.chunk(entries);
    expect(Sitemap.parse(xml)).toEqual({ kind: "urlset", urls: entries });
  });

  test("reads a prefixed sitemap index", () => {
    const xml = `<sm:sitemapindex xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sm:sitemap><sm:loc>https://example.com/s1.xml</sm:loc><sm:lastmod>2026-10-07</sm:lastmod></sm:sitemap>
    </sm:sitemapindex>`;
    expect(Sitemap.parse(xml)).toEqual({
      kind: "index",
      sitemaps: [{ loc: "https://example.com/s1.xml", lastmod: "2026-10-07" }],
    });
  });

  test("reads a text sitemap", () => {
    expect(Sitemap.parse("https://example.com/a\r\n\nnot a url\nhttps://example.com/b\n")).toEqual({
      kind: "urlset",
      urls: [{ loc: "https://example.com/a" }, { loc: "https://example.com/b" }],
    });
  });

  test("stops at maxUrls", () => {
    const [xml] = Sitemap.chunk(
      Array.from({ length: 10 }, (_, i) => ({ loc: `https://example.com/${i}` })),
    );
    expect((Sitemap.parse(xml, { maxUrls: 3 }) as { urls: unknown[] }).urls).toHaveLength(3);
  });

  test("an HTML page is not a sitemap", () => {
    expect(() => Sitemap.parse("<!doctype html><html><body>Not found</body></html>")).toThrow(
      SitemapError,
    );
    expect(() => Sitemap.parse("hello")).toThrow(SitemapError);
  });

  test("truncated XML yields what was complete", () => {
    const xml = `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://exa`;
    expect(Sitemap.parse(xml)).toEqual({
      kind: "urlset",
      urls: [{ loc: "https://example.com/a" }],
    });
  });
});

/**
 * A loopback server stands in for public sites, reached as `site.test` through
 * a test resolver with exactly 127.0.0.1 let through `allowPrivate`.
 */
let server: ReturnType<typeof Bun.serve>;
let base: string;
const requests: string[] = [];

const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join("")}</urlset>`;
const sitemapindex = (...locs: string[]) =>
  `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
    .join("")}</sitemapindex>`;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      const at = (path: string) => `${base}${path}`;
      switch (url.pathname) {
        case "/index.xml":
          return new Response(sitemapindex(at("/one.xml"), at("/two.xml.gz"), at("/nested.xml")));
        case "/one.xml":
          return new Response(urlset("https://site.test/1", "https://site.test/2"));
        case "/two.xml.gz":
          return new Response(gzipSync(urlset("https://site.test/3")), {
            headers: { "content-type": "application/gzip" },
          });
        case "/nested.xml":
          return new Response(sitemapindex(at("/deep.xml"), at("/one.xml")));
        case "/deep.xml":
          return new Response(urlset("https://site.test/4"));
        case "/loop.xml":
          return new Response(sitemapindex(at("/loop.xml"), at("/one.xml")));
        case "/broken-index.xml":
          return new Response(sitemapindex(at("/missing.xml"), at("/one.xml")));
        case "/private-index.xml":
          return new Response(sitemapindex("http://10.0.0.1/secret.xml", at("/one.xml")));
        case "/bomb.xml.gz":
          return new Response(gzipSync(Buffer.alloc(5_000_000, 0x20)), {
            headers: { "content-type": "application/gzip" },
          });
        case "/encoded.xml":
          return new Response(gzipSync(urlset("https://site.test/enc")), {
            headers: { "content-encoding": "gzip", "content-type": "application/xml" },
          });
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });
  base = `http://site.test:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const fetchOptions = {
  resolve: async () => ["127.0.0.1"],
  allowPrivate: ["127.0.0.1/32"],
  ports: "any" as const,
};

async function all(url: string, options: Parameters<typeof Sitemap.read>[1] = {}) {
  const out: { loc: string; sitemap: string }[] = [];
  for await (const entry of Sitemap.read(url, { ...fetchOptions, ...options })) {
    out.push({ loc: entry.loc, sitemap: entry.sitemap.replace(base, "") });
  }
  return out;
}

describe("Sitemap.read", () => {
  test("follows indexes depth-first, inflates gzip, fetches each file once", async () => {
    requests.length = 0;
    expect(await all(`${base}/index.xml`)).toEqual([
      { loc: "https://site.test/1", sitemap: "/one.xml" },
      { loc: "https://site.test/2", sitemap: "/one.xml" },
      { loc: "https://site.test/3", sitemap: "/two.xml.gz" },
      { loc: "https://site.test/4", sitemap: "/deep.xml" },
    ]);
    expect(requests).toEqual(["/index.xml", "/one.xml", "/two.xml.gz", "/nested.xml", "/deep.xml"]);
  });

  test("Content-Encoding gzip is handled by safeFetch", async () => {
    expect(await all(`${base}/encoded.xml`)).toEqual([
      { loc: "https://site.test/enc", sitemap: "/encoded.xml" },
    ]);
  });

  test("stops at maxUrls", async () => {
    requests.length = 0;
    expect((await all(`${base}/index.xml`, { maxUrls: 3 })).map((e) => e.loc)).toEqual([
      "https://site.test/1",
      "https://site.test/2",
      "https://site.test/3",
    ]);
    expect(requests).not.toContain("/nested.xml");
  });

  test("stops at maxSitemaps", async () => {
    requests.length = 0;
    await all(`${base}/index.xml`, { maxSitemaps: 2 });
    expect(requests).toEqual(["/index.xml", "/one.xml"]);
  });

  test("maxDepth limits how many index levels are followed", async () => {
    requests.length = 0;
    const entries = await all(`${base}/index.xml`, { maxDepth: 1 });
    expect(entries.map((e) => e.loc)).toEqual([
      "https://site.test/1",
      "https://site.test/2",
      "https://site.test/3",
    ]);
    expect(requests).not.toContain("/deep.xml");
  });

  test("an index listing itself doesn't loop", async () => {
    expect((await all(`${base}/loop.xml`)).map((e) => e.loc)).toEqual([
      "https://site.test/1",
      "https://site.test/2",
    ]);
  });

  test("a failing child throws, or is reported to onError and skipped", async () => {
    await expect(all(`${base}/broken-index.xml`)).rejects.toMatchObject({ status: 404 });
    const errors: string[] = [];
    const entries = await all(`${base}/broken-index.xml`, {
      onError: (_error, url) => errors.push(url.replace(base, "")),
    });
    expect(errors).toEqual(["/missing.xml"]);
    expect(entries).toHaveLength(2);
  });

  test("a child at a private address is refused by safeFetch", async () => {
    await expect(all(`${base}/private-index.xml`)).rejects.toBeInstanceOf(BlockedAddressError);
    const errors: unknown[] = [];
    await all(`${base}/private-index.xml`, { onError: (error) => errors.push(error) });
    expect(errors[0]).toBeInstanceOf(BlockedAddressError);
  });

  test("the first URL failing always throws", async () => {
    await expect(all(`${base}/missing.xml`, { onError: () => {} })).rejects.toBeInstanceOf(
      SitemapError,
    );
  });

  test("a gzip bomb stops at maxSize", async () => {
    await expect(all(`${base}/bomb.xml.gz`, { maxSize: 1_000_000 })).rejects.toBeInstanceOf(
      TooLargeError,
    );
  });

  test("goes through safeFetch: loopback without allowPrivate is refused", async () => {
    const read = Sitemap.read(`http://127.0.0.1:${server.port}/one.xml`, { ports: "any" });
    await expect(read.next()).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
