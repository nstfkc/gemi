import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import { Dictionary } from "./Dictionary";

/**
 * #1199: the translations route answers an app with no translations (or a
 * locale it has none for) with an empty dictionary, never a 500.
 */

class RootApiRouter extends ApiRouter {
  routes = {};
}

function kernel(translation?: Record<string, any>) {
  return class AppKernel extends Kernel {
    config = {
      route: {
        api: { rootRouter: RootApiRouter },
        view: {
          root: createRoot(() => createElement("div")),
          rootRouter: class extends ViewRouter {},
        },
      },
      ...(translation ? { translation } : {}),
    };
  };
}

async function get(app: App, path: string) {
  const res = await app.fetch(
    new Request(`http://gemi.dev/api/__gemi__/services/i18n/translations${path}`),
  );
  return { status: res.status, body: await res.json() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("translations route (#1199)", () => {
  test("an app with no translation config answers 200 with an empty dictionary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new App({ kernel: kernel() });

    expect(await get(app, "/en-US")).toEqual({ status: 200, body: { "en-US": {} } });
    expect(await get(app, "/en-US/settings/profile")).toEqual({
      status: 200,
      body: { "en-US": {} },
    });
  });

  test("a locale the app has no translations for answers an empty dictionary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const greeting = new Dictionary("greeting", {
      hello: { "en-US": "Hello", "de-DE": "Hallo" },
    } as any);
    const app = new App({
      kernel: kernel({
        supportedLocales: ["en-US", "de-DE"],
        defaultLocale: "en-US",
        prefetch: { "/": [greeting] },
      }),
    });

    expect(await get(app, "/de-DE")).toEqual({
      status: 200,
      body: { "de-DE": { greeting: { hello: "Hallo" } } },
    });
    expect(await get(app, "/de-DE/elsewhere")).toEqual({ status: 200, body: { "de-DE": {} } });
    expect(await get(app, "/fr-FR")).toEqual({ status: 200, body: { "fr-FR": {} } });
  });
});
