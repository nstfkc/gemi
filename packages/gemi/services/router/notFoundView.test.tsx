import { describe, expect, test, vi } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { useLocation } from "../../client/useLocation";
import { Meta } from "../../facades/Meta";
import { ApiRouter } from "../../http/ApiRouter";
import { InsufficientPermissionsError } from "../../http/errors";
import type { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { RecordNotFoundError } from "../../orm/errors";

/**
 * The app's `404` document:
 * - is styled with the `404` view's chain, like a matched view (#951);
 * - lets the `404` view read the requested path with `useLocation()` (#952);
 * - gets its title from `route.view.onNotFound` (#954).
 */

process.env.SECRET ??= "not-found-view-test-secret";

const Layout = (props: RootLayoutProps) => (
  <html {...props.htmlAttributes}>
    <Head />
    <body>{props.children}</body>
  </html>
);

function NotFound() {
  const { pathname, search } = useLocation();
  return <p id="nf">{`${pathname}|${search}`}</p>;
}
const Page = () => <main>page</main>;

const views: Record<string, any> = { "404": NotFound, Page };

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
    "/": this.view("Page", () => ({})),
    "/pages/:pageId/:rest*": this.view("Page", () => {
      Meta.title("a page");
      throw new RecordNotFoundError("Page", "findUniqueOrThrow");
    }),
    "/private": this.view("Page", () => ({})).middleware(["forbidden"]),
  };
}

const notFoundCalls: { path: string; status: number }[] = [];

function kernel(onNotFound?: (req: HttpRequest, info: { status: number }) => void) {
  return class extends Kernel {
    config = {
      middleware: { aliases: { forbidden: Forbidden } },
      translation: { supportedLocales: ["en-US", "de-DE"], defaultLocale: "en-US" },
      route: {
        api: { rootRouter: RootApiRouter },
        view: { root: createRoot(Layout), rootRouter: RootViewRouter, onNotFound },
      },
    };
  };
}

const withHook = new App({
  kernel: kernel((req, { status }) => {
    notFoundCalls.push({ path: new URL(req.rawRequest.url).pathname, status });
    Meta.title(`Not here (${status})`);
    Meta.description("Nothing at this address");
  }),
});
const withoutHook = new App({ kernel: kernel() });

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

async function visit(app: App, path: string) {
  const params = renderParams();
  const answer = await app.fetch(new Request(`http://localhost${path}`));
  const res =
    typeof answer === "function"
      ? ((await (answer as any)(params)) as Response)
      : (answer as Response);
  return { status: res.status, body: await res.text(), getStyles: params.getStyles };
}

const shownPath = (body: string) => body.match(/<p id="nf">([^<]*)<\/p>/)?.[1] ?? null;
const title = (body: string) => body.match(/<title>([^<]*)<\/title>/)?.[1] ?? null;

describe("the 404 document", () => {
  test.each([
    ["an unmatched path", "/does/not/exist?x=1", 404, "/does/not/exist|?x=1"],
    ["a missing record", "/pages/aB3dE9xYz/assets", 404, "/pages/aB3dE9xYz/assets|"],
    ["a refusal", "/private", 403, "/private|"],
    ["a locale-prefixed path", "/de-DE/nope", 404, "/nope|"],
  ])("%s: the 404 view reads the requested path (#952)", async (_, path, status, shown) => {
    const res = await visit(withoutHook, path);
    expect(res.status).toBe(status);
    expect(shownPath(res.body)).toBe(shown);
  });

  test("is styled with the 404 view's chain (#951)", async () => {
    const res = await visit(withoutHook, "/does/not/exist");
    expect(res.status).toBe(404);
    expect(res.getStyles).toHaveBeenCalledWith(["404"]);
  });

  test("keeps gemi's default title without an onNotFound", async () => {
    const res = await visit(withoutHook, "/does/not/exist");
    expect(title(res.body)).toBe("Gemi App");
  });

  test.each([
    ["/does/not/exist", 404, "Not here (404)"],
    ["/pages/aB3dE9xYz", 404, "Not here (404)"],
    ["/private", 403, "Not here (403)"],
  ])("%s: onNotFound sets the title (#954)", async (path, status, expected) => {
    notFoundCalls.length = 0;
    const res = await visit(withHook, path);
    expect(res.status).toBe(status);
    expect(title(res.body)).toBe(expected);
    expect(res.body).toContain("Nothing at this address");
    expect(notFoundCalls).toEqual([{ path, status }]);
  });

  test("onNotFound does not run for a matched route", async () => {
    notFoundCalls.length = 0;
    const res = await visit(withHook, "/");
    expect(res.status).toBe(200);
    expect(notFoundCalls).toEqual([]);
  });

  test("a client navigation to a 404 carries the onNotFound metadata", async () => {
    const res = await visit(withHook, "/does/not/exist.json");
    const envelope = JSON.parse(res.body.split("\n")[0]);
    expect(envelope.is404).toBe(true);
    expect(envelope.meta.title).toBe("Not here (404)");
  });
});
