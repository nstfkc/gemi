# Sitemaps & robots.txt

`Sitemap` and `Robots` from `gemi/http` write your site's `/sitemap.xml` and `/robots.txt`, and read another site's, for example to find the pages of a site you are importing.

## Serving them

Both build a `Response`, so a [file route](./routing.md) on the view router can return them as they are. Put them on the root router, outside locale routing (`no-locale`), so a crawler that sends `Accept-Language` isn't redirected to `/tr-TR/sitemap.xml`:

```typescript
// app/http/routes/view.ts
import { ViewRouter } from "gemi/http";
import { SeoController } from "../controllers/SeoController";

export default class RootViewRouter extends ViewRouter {
  routes = {
    "/sitemap.xml": this.file(SeoController, "sitemap").middleware(["no-locale"]),
    "/robots.txt": this.file(SeoController, "robots").middleware(["no-locale"]),
    // …
  };
}
```

```typescript
// app/http/controllers/SeoController.ts
import { Controller, HttpRequest, Robots, Sitemap } from "gemi/http";

const origin = process.env.HOST_NAME; // "https://example.com"

export class SeoController extends Controller {
  async sitemap(req: HttpRequest) {
    const pages = await Page.findMany({ where: { published: true }, include: { translations: true } });
    return Sitemap.response(
      pages.map((page) => ({
        loc: `${origin}/${page.slug}`,
        lastmod: page.updatedAt,
        alternates: page.translations.map((t) => ({
          hrefLang: t.locale,
          href: `${origin}/${t.locale}/${page.slug}`,
        })),
      })),
      {
        page: req.search.get("page"),
        pageUrl: (page) => `${origin}/sitemap.xml?page=${page}`,
        headers: { "Cache-Control": "public, max-age=3600" },
      },
    );
  }

  async robots() {
    return Robots.response({
      rules: [
        { userAgent: "*", disallow: ["/admin", "/api/"] },
        { userAgent: "GPTBot", disallow: "/" },
      ],
      sitemaps: [`${origin}/sitemap.xml`],
    });
  }
}
```

A static `public/robots.txt` or `public/sitemap.xml` is served before your routes, so remove it when a route takes over.

## Writing a sitemap

Each entry is a `SitemapEntry`:

| Field | |
|---|---|
| `loc` | The page's absolute http(s) URL, at most 2048 characters. Written percent-encoded and XML-escaped. |
| `lastmod` | A `Date` (written as ISO 8601) or a W3C datetime string (`"2026-10-07"`, `"2026-10-07T12:00:00+02:00"`). |
| `changefreq` | `"always"`, `"hourly"`, `"daily"`, `"weekly"`, `"monthly"`, `"yearly"` or `"never"`. |
| `priority` | From 0 to 1. |
| `alternates` | `{ hrefLang, href }[]`, the `AlternateLink` that `Meta.alternates` takes, written as `<xhtml:link rel="alternate" hreflang="…">`. List every language version, the page's own included, and `x-default` if you have one: Google ignores alternates that don't point back at each other. |

Anything else throws `SitemapError`, so a bad URL fails while you are writing the route rather than in Search Console.

**Large sites.** One sitemap file holds at most 50 000 URLs and 50 MB (uncompressed). `Sitemap.response` splits past either limit: the route then answers a `<sitemapindex>` of `pageUrl(1)`, `pageUrl(2)`, …, and `?page=N` answers file N (a page that doesn't exist is a 404). Without `pageUrl` it throws once a second file is needed. `maxUrls` and `maxBytes` set lower limits.

Every request builds the whole list to answer one file, so let caches keep it (`Cache-Control` in `headers`, as above) when the list is expensive to build. To write the files somewhere else (storage, a build step), `Sitemap.chunk(entries, { maxUrls?, maxBytes? })` returns the `<urlset>` documents as strings, and `Sitemap.index([{ loc, lastmod? }])` the index for them.

## Writing robots.txt

`Robots.response(config, { headers? })` answers `text/plain`; `Robots.text(config)` returns the text.

| Field | |
|---|---|
| `rules` | `{ userAgent, allow?, disallow?, crawlDelay? }[]`, one group each. `userAgent` is a product token (`"Googlebot"`) or `"*"`, or a list of them; `allow` and `disallow` are a path or a list, each starting with `/` or `*` (`*` is any run of characters, a trailing `$` the end of the URL). A group with neither gets an empty `Disallow:`, which allows everything. |
| `sitemaps` | Absolute URLs. |

A value with a line break in it throws, so a value from your database can't add rules of its own.

## Reading robots.txt

```typescript
import { Robots } from "gemi/http";

const robots = await Robots.fetch("https://example.com/any/page");
robots.isAllowed("/admin/users", "MyCrawler"); // false
robots.isAllowed("https://example.com/blog?page=2"); // the "*" group
robots.crawlDelay("MyCrawler"); // seconds, or null
robots.sitemaps; // ["https://example.com/sitemap.xml"]
```

`Robots.fetch(site, options?)` fetches `/robots.txt` of the site's origin through [`safeFetch`](./outbound-http.md), so it reaches only public addresses and takes the same options (`timeout`, `headers` for your crawler's `User-Agent`, `allowPrivate` in tests, …). It reads at most `maxSize` bytes (500 KiB) and ignores the rest, as RFC 9309 allows. What the answer means follows the RFC, and is in `robots.status`:

| Answer | `status` | Meaning |
|---|---|---|
| 2xx | `"parsed"` | The rules apply. |
| 4xx (a 404) | `"unavailable"` | Everything is allowed. |
| 5xx or 429 | `"unreachable"` | Everything is disallowed. |

A timeout, network error or refused address throws the `SafeFetchError`; the RFC says to treat that as unreachable too.

`isAllowed(pathOrUrl, userAgent = "*")` follows RFC 9309: the groups for the user agent's product token (case-insensitive, `MyCrawler/1.0` is `mycrawler`), else the `*` groups; the longest matching rule wins and `Allow` wins a tie; paths are compared percent-encoded; `/robots.txt` is always allowed. Patterns are matched without regular expressions, so a hostile file can't make it backtrack.

`Robots.parse(text, { url? })` parses text you already have; `url` resolves relative `Sitemap:` lines.

## Reading a sitemap

```typescript
import { Robots, Sitemap } from "gemi/http";

const robots = await Robots.fetch(siteUrl);
for (const sitemapUrl of robots.sitemaps) {
  for await (const page of Sitemap.read(sitemapUrl, { maxUrls: 500 })) {
    page.loc; // "https://example.com/about"
    page.lastmod; // "2026-10-07", as the file wrote it
    page.alternates; // [{ hrefLang: "de", href: "…" }]
    page.sitemap; // the file it came from
  }
}
```

`Sitemap.read(url, options?)` is an async iterator. It fetches through `safeFetch` (and takes its options), follows sitemap indexes depth-first, inflates `.xml.gz` files, reads plain-text sitemaps (one URL per line), and skips entries whose `loc` isn't an http(s) URL. It is bounded:

| Option | Default | |
|---|---|---|
| `maxUrls` | `50_000` | Pages yielded in all. |
| `maxSitemaps` | `50` | Files fetched in all, indexes included. A file is never fetched twice, so an index that lists itself ends. |
| `maxDepth` | `3` | Levels of index followed. |
| `maxSize` | 50 MB | Largest file, after decompression; a gzip bomb stops there with `TooLargeError`. |
| `onError` | | `(error, url) => void`. A file listed in an index that fails (an error status, a timeout, not a sitemap) is passed here and skipped. Without it, the error is thrown. The first URL failing always throws. |

An error status throws `SitemapError` with `status` and `url`. Stopping the loop early (`break`) stops fetching.

`Sitemap.parse(text, { maxUrls? })` parses a document you already have into `{ kind: "urlset", urls }` or `{ kind: "index", sitemaps }`. The parser is deliberately small: it matches elements by local name, ignores extension elements (`image:image`, `video:video`), and never expands entities a DOCTYPE declares.
