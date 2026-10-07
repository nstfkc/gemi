import { createElement } from "react";
import { describe, expect, test } from "vitest";

import { createRoot } from "../client/createRoot";
import { Redirect } from "../facades/Redirect";
import { ApiRouter } from "../http/ApiRouter";
import { HttpRequest } from "../http/HttpRequest";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import { App } from "./App";

/**
 * A view handler that sets a cookie and then breaks the request (a redirect,
 * a 404) sends the cookie with the break. Before #845 the break's response
 * was built without the request context, so the cookie was dropped — an OAuth
 * connection's state cookie set ahead of `Redirect.external` never reached
 * the browser, and the callback refused the round trip.
 */

class RootViewRouter extends ViewRouter {
  routes = {
    "/go": this.redirect(async (req = new HttpRequest()) => {
      req.ctx().setCookie("round_trip", "abc", { httpOnly: true, sameSite: "Lax" });
      Redirect.external("https://provider.example/authorize");
      return { destination: "/" };
    }),
  };
}

class AppKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: class extends ApiRouter {} },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: RootViewRouter,
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

describe("a view break carries the handler's cookies", () => {
  test("a redirect thrown after setCookie sends the cookie", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/go"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://provider.example/authorize");
    expect(res.headers.getSetCookie()).toContainEqual(expect.stringMatching(/^round_trip=abc;.*HttpOnly/));
  });
});
