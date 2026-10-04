import { afterAll, describe, expect, test } from "vitest";
import type { ReactNode } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import { useDictionary } from "../../client/useDictionary";
import { useQuery } from "../../client/useQuery";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { defineDictionary } from "../../i18n/defineDictionary";
import { __resetDictionaryRegistry } from "../../i18n/dictionaryRegistry";
import { Kernel } from "../../kernel";

/**
 * A static view reads data and translations the way any view does: both
 * resolve on the server, land in the markup, and nothing about them is
 * shipped as script.
 */

process.env.SECRET ??= "static-view-data-test-secret";

const dict = defineDictionary({
  greeting: { "en-US": "Hello", "tr-TR": "Merhaba" },
});

afterAll(() => {
  __resetDictionaryRegistry();
});

const Layout = (props: { children: ReactNode; locale: string }) => (
  <html lang={props.locale}>
    <Head />
    <body>{props.children}</body>
  </html>
);

function Greeting() {
  const t = useDictionary(dict);
  const { data } = useQuery("/opening-hours" as any);
  return (
    <main>
      <h1>{t("greeting")}</h1>
      <p>{(data as any)?.hours}</p>
    </main>
  );
}

class TestApiRouter extends ApiRouter {
  routes = {
    "/opening-hours": this.get(() => ({ hours: "Mon–Sat 9–18" })),
  };
}

class TestViewRouter extends ViewRouter {
  routes = {
    "/hello": this.view("Greeting").static(),
  };
}

class TestKernel extends Kernel {
  config = {
    translation: { supportedLocales: ["en-US", "tr-TR"], defaultLocale: "en-US" },
    route: {
      api: { rootRouter: TestApiRouter },
      view: { root: createRoot(Layout), rootRouter: TestViewRouter },
    },
  };
}

const app = new App({ kernel: TestKernel });

const params = {
  getStyles: async () => [],
  viewImportMap: { "404": () => null, Greeting },
  viewModules: { Greeting: { default: Greeting } },
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
};

async function fetchDocument(path: string) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(typeof render).toBe("function");
  return await ((await (render as any)(params)) as Response).text();
}

describe("a static view", () => {
  test("renders its locale's dictionary and its query data into the markup", async () => {
    const html = await fetchDocument("/tr-TR/hello");

    expect(html).toContain('<html lang="tr-TR">');
    expect(html).toContain("<h1>Merhaba</h1>");
    expect(html).toContain("<p>Mon–Sat 9–18</p>");
    // No dictionary or query payload scripts, no hydration data.
    expect(html).not.toContain("<script");
  });

  test("renders the default locale too", async () => {
    const html = await fetchDocument("/en-US/hello");
    expect(html).toContain("<h1>Hello</h1>");
  });
});
