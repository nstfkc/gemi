import { describe, expect, test, vi } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { useLocation } from "../../client/useLocation";
import { Meta } from "../../facades/Meta";
import { ApiRouter } from "../../http/ApiRouter";
import { InsufficientPermissionsError, NotFoundError } from "../../http/errors";
import type { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { RecordNotFoundError } from "../../orm/errors";

/**
 * `route.view.notFound` (#828): a `route.domains` group's own not-found page,
 * served as a static document with the group's layout, for an unmatched path
 * and for a handler's not-found alike. The root keeps its hydrated `404`.
 */

process.env.SECRET ??= "not-found-static-test-secret";

const AppLayout = (props: RootLayoutProps) => (
  <html {...props.htmlAttributes} data-layout="app">
    <Head />
    <body>{props.children}</body>
  </html>
);

const ShopLayout = (props: { children?: React.ReactNode }) => (
  <html data-layout="shop">
    <Head />
    <body>{props.children}</body>
  </html>
);

const AppNotFound = () => <p id="app-404">app not found</p>;

function ShopNotFound(props: { shop?: string; status?: number }) {
  const { pathname } = useLocation();
  return (
    <p id="shop-404">{`${props.shop ?? "no props"}|${props.status ?? ""}|${pathname}`}</p>
  );
}

const Page = (props: { text: string }) => <main>{props.text}</main>;

const views: Record<string, any> = {
  "404": AppNotFound,
  Page,
  "shop/ShopLayout": ShopLayout,
  "shop/NotFound": ShopNotFound,
};

class Forbidden extends Middleware {
  run() {
    throw new InsufficientPermissionsError();
  }
}

class RootApiRouter extends ApiRouter {
  routes = {};
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Page", () => ({ text: "home" })),
  };
}

class ShopViewRouter extends ViewRouter {
  override routes = {
    "/": this.view("Page", () => ({ text: "shop home" })).static({ layout: "shop/ShopLayout" }),
    "/products/:slug": this.view("Page", (req: HttpRequest<any, { slug: string }>) => {
      if (req.params.slug === "gone") throw new NotFoundError();
      if (req.params.slug === "missing") {
        throw new RecordNotFoundError("Product", "findUniqueOrThrow");
      }
      return { text: req.params.slug };
    }).static({ layout: "shop/ShopLayout", cacheControl: "public, max-age=60" }),
    "/private": this.view("Page", () => ({ text: "private" }))
      .middleware(["forbidden"])
      .static({ layout: "shop/ShopLayout" }),
    "/beta": this.view("Page", () => ({ text: "beta" }))
      .feature("shop-beta" as any)
      .static({ layout: "shop/ShopLayout" }),
    // A hydrated page in the same group: its `.json` navigation keeps the
    // client's `is404`.
    "/account/:id": this.view("Page", () => {
      throw new NotFoundError();
    }),
  };
}

const onNotFound = vi.fn((req: HttpRequest, { status }: { status: number }) => {
  Meta.title(`${req.domain?.params.shop} is unavailable`);
  return { shop: req.domain?.params.shop, status };
});

class TestKernel extends Kernel {
  config = {
    middleware: { aliases: { forbidden: Forbidden } },
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(AppLayout), rootRouter: RootViewRouter },
      domains: {
        root: "example.test",
        groups: [
          {
            subdomain: ":shop",
            view: {
              rootRouter: ShopViewRouter,
              theme: false as const,
              onNotFound,
              notFound: {
                view: "shop/NotFound",
                static: { layout: "shop/ShopLayout", cacheControl: "public, max-age=300" },
              },
            },
          },
        ],
      },
    },
  };
}

const app = new App({ kernel: TestKernel });

function renderParams() {
  return {
    getStyles: vi.fn(async () => []),
    viewImportMap: views,
    viewModules: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { default: v }])),
    loaders: "{}",
    cssManifest: {},
    ogMap: {},
    clientEntry: { module: "/assets/client.js", preload: ["/assets/client.js"] },
    modulePreloadManifest: {},
  };
}

async function visit(url: string) {
  const params = renderParams();
  const answer = await app.fetch(new Request(url));
  const res =
    typeof answer === "function"
      ? ((await (answer as any)(params)) as Response)
      : (answer as Response);
  const body = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body,
    getStyles: params.getStyles,
    shown: body.match(/<p id="shop-404">([^<]*)<\/p>/)?.[1] ?? null,
    layout: body.match(/data-layout="(\w+)"/)?.[1] ?? null,
    hydrated: body.includes("__GEMI_DATA__") || body.includes("/assets/client.js"),
  };
}

describe("a group's static notFound", () => {
  test("an unmatched path renders it statically, with the group's layout and onNotFound's props", async () => {
    const res = await visit("http://acme.example.test/nope?x=1");
    expect(res.status).toBe(404);
    expect(res.shown).toBe("acme|404|/nope");
    expect(res.layout).toBe("shop");
    expect(res.hydrated).toBe(false);
    expect(res.body).toContain("<title>acme is unavailable</title>");
    expect(res.body).not.toContain("app not found");
    expect(res.getStyles).toHaveBeenCalledWith(["shop/NotFound"], {
      static: true,
      layout: "shop/ShopLayout",
    });
  });

  test("an unmatched path gets the page's cacheControl and no cookies", async () => {
    const res = await visit("http://acme.example.test/nope");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("Vary") ?? "").not.toContain("User-Agent");
  });

  test.each([
    ["a handler's NotFoundError", "/products/gone", 404],
    ["a handler's RecordNotFoundError", "/products/missing", 404],
    ["a middleware's refusal", "/private", 403],
  ])("%s renders it under its own status, never cached", async (_, path, status) => {
    const res = await visit(`http://acme.example.test${path}`);
    expect(res.status).toBe(status);
    expect(res.shown).toBe(`acme|${status}|${path}`);
    expect(res.layout).toBe("shop");
    expect(res.hydrated).toBe(false);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a closed feature gate renders it without the page's cacheControl", async () => {
    const res = await visit("http://acme.example.test/beta");
    expect(res.status).toBe(404);
    expect(res.shown).toBe("acme|404|/beta");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  test("a matched page of the group is untouched", async () => {
    const res = await visit("http://acme.example.test/products/shoe");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<main>shoe</main>");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  test("a .json navigation still answers the client's is404 envelope", async () => {
    const res = await app.fetch(new Request("http://acme.example.test/account/1.json"));
    const body = await (res as Response).text();
    expect((res as Response).status).toBe(200);
    expect(JSON.parse(body.split("\n")[0]).is404).toBe(true);
  });

  test("the root keeps the app's hydrated 404 view", async () => {
    const res = await visit("http://example.test/nope");
    expect(res.status).toBe(404);
    expect(res.body).toContain("app not found");
    expect(res.layout).toBe("app");
    expect(res.hydrated).toBe(true);
    expect(res.shown).toBeNull();
  });

  test("its view and layout are loaded up front", async () => {
    expect(app.getFlatComponentTree()).toEqual(
      expect.arrayContaining(["shop/NotFound", "shop/ShopLayout"]),
    );
  });
});
