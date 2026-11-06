import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import { island } from "../../client/islands";
import { Query } from "../../facades/Prefetch";
import { ApiRouter } from "../../http/ApiRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import * as Feed from "./__fixtures__/islands/Feed";

/**
 * `useQuery` inside an island on a static page (#1155), on the server: the
 * island renders the queries the view handler prefetched, and the document
 * carries exactly those it read. `islandQueries.browser.test.tsx` hydrates
 * such a document.
 */

process.env.SECRET ??= "island-queries-test-secret";

const viaPlugin = (key: string, mod: Record<string, unknown>) =>
  Object.assign(() => Promise.resolve(mod), { gemiIsland: key, gemiModule: mod }) as () => Promise<any>;

const FeedIsland = island(viaPlugin("app/views/site/Feed.tsx", Feed));
const CountIsland = island(viaPlugin("app/views/site/Feed.tsx", Feed), { export: "Count" });
const PlainIsland = island(viaPlugin("app/views/site/Feed.tsx", Feed), { export: "PlainCounter" });

const Layout = (props: { children?: ReactNode }) => (
  <html>
    <Head />
    <body>{props.children}</body>
  </html>
);

const views: Record<string, any> = {
  "404": () => <p>not found</p>,
  "site/Layout": Layout,
  "site/Feed": () => (
    <main>
      <FeedIsland />
    </main>
  ),
  "site/Tagged": () => (
    <main>
      <FeedIsland tag="news" />
    </main>
  ),
  "site/Count": () => (
    <main>
      <CountIsland />
    </main>
  ),
  "site/Plain": () => (
    <main>
      <PlainIsland />
    </main>
  ),
  "site/NoIslands": () => (
    <main>
      <p>no islands</p>
    </main>
  ),
};

const calls = vi.fn((_path: string) => {});

const posts = (tag: string | null) =>
  tag
    ? [{ id: 3, title: `Only ${tag}` }]
    : [
        { id: 1, title: "First </script> post" },
        { id: 2, title: "Second post" },
      ];

class SiteApiRouter extends ApiRouter {
  routes = {
    "/posts": this.get((req: HttpRequest) => {
      calls("/posts");
      return posts(new URL(req.rawRequest.url).searchParams.get("tag"));
    }),
    "/count": this.get(() => {
      calls("/count");
      return { n: 42 };
    }),
    "/unused": this.get(() => {
      calls("/unused");
      return { secret: "not for this page" };
    }),
  };
}

const prefetch = Query.prefetch as (path: string, options?: object) => void;
const instant = Query.instant as (path: string, options?: object) => Promise<unknown>;

class SiteViewRouter extends ViewRouter {
  override routes = {
    "/feed": this.view("site/Feed", () => {
      prefetch("/posts");
      // Prefetched, read by no island: not shipped.
      prefetch("/unused");
      return {};
    }).static({ layout: "site/Layout" }),
    "/feed-unprefetched": this.view("site/Feed").static({ layout: "site/Layout" }),
    // A variant the island does not read: the island's own is not prefetched.
    "/tagged": this.view("site/Tagged", () => {
      prefetch("/posts");
      return {};
    }).static({ layout: "site/Layout" }),
    "/count": this.view("site/Count", async () => {
      await instant("/count");
      return {};
    }).static({ layout: "site/Layout" }),
    "/plain": this.view("site/Plain", () => {
      prefetch("/posts");
      return {};
    }).static({ layout: "site/Layout" }),
    "/no-islands": this.view("site/NoIslands", () => {
      prefetch("/posts");
      return {};
    }).static({ layout: "site/Layout" }),
  };
}

class TestKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: SiteApiRouter },
      view: { root: createRoot(Layout as any), rootRouter: SiteViewRouter },
    },
  };
}

const app = new App({ kernel: TestKernel });

const params = {
  getStyles: async () => [],
  viewImportMap: views,
  viewModules: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { default: v }])),
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
  clientEntry: { module: "/assets/client.js", preload: ["/assets/client.js"] },
  modulePreloadManifest: {},
  resolveIsland: (key: string) =>
    key === "app/views/site/Feed.tsx" ? { src: "/assets/Feed.js", preload: ["/assets/Feed.js"] } : undefined,
};

async function fetchDocument(url: string) {
  const answer = await app.fetch(new Request(url));
  expect(typeof answer).toBe("function");
  const res = (await (answer as any)(params)) as Response;
  expect(res.status).toBe(200);
  return await res.text();
}

const BLOCK = /<script type="application\/json" id="gemi-island-queries">([\s\S]*?)<\/script>/;
const payload = (html: string) => {
  const json = html.match(BLOCK)?.[1];
  return json === undefined ? undefined : JSON.parse(json);
};
const items = (html: string) => [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);

afterEach(() => {
  calls.mockClear();
  vi.restoreAllMocks();
});

describe("useQuery in an island on a static page", () => {
  test("renders a prefetched query on the server and carries only what islands read", async () => {
    const html = await fetchDocument("http://example.test/feed");
    expect(items(html)).toEqual(["First &lt;/script&gt; post", "Second post"]);
    expect(payload(html)).toEqual({ "/posts": { "": posts(null) } });
    // Fetched once, by the prefetch: the island joined it.
    expect(calls.mock.calls.filter(([path]) => path === "/posts")).toHaveLength(1);
    // Next to the island table, before the loader, and escaped.
    const block = html.match(BLOCK)![1];
    expect(block).not.toContain("<");
    expect(html.indexOf('id="gemi-islands"')).toBeLessThan(html.indexOf('id="gemi-island-queries"'));
    expect(html.indexOf('id="gemi-island-queries"')).toBeLessThan(html.indexOf('<script type="module">'));
    expect(html).not.toContain("not for this page");
  });

  test("a query the handler did not prefetch is not fetched on the server, as before", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await fetchDocument("http://example.test/feed-unprefetched");
    expect(items(html)).toEqual([]);
    expect(html).toContain('id="gemi-islands"');
    expect(html).not.toContain("gemi-island-queries");
    expect(calls).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Query.prefetch("/posts")'));
  });

  test("another variant of the path is not the island's query", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await fetchDocument("http://example.test/tagged");
    expect(items(html)).toEqual([]);
    expect(html).not.toContain("gemi-island-queries");
  });

  test("a query read without suspense renders the prefetched data and ships it", async () => {
    const html = await fetchDocument("http://example.test/count");
    expect(html).toContain("<output>42</output>");
    expect(payload(html)).toEqual({ "/count": { "": { n: 42 } } });
  });

  test("a page whose islands read no query carries no block", async () => {
    const html = await fetchDocument("http://example.test/plain");
    expect(html).toContain('id="gemi-islands"');
    expect(html).not.toContain("gemi-island-queries");
  });

  test("a page without islands ships no script, prefetched queries or not", async () => {
    const html = await fetchDocument("http://example.test/no-islands");
    expect(html).toContain("<p>no islands</p>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("First");
  });
});
