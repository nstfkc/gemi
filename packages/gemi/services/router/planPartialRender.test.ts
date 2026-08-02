import { describe, test, expect } from "vitest";

import {
  planPartialRender,
  resolvePartialRender,
  type PartialRenderRoute,
} from "./planPartialRender";
import { createFlatViewRoutes } from "./createFlatViewRoutes";
import { ViewRouter } from "../../http/ViewRouter";

class AppRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/app/:orgId": this.layout("AppLayout", {
      "/": this.view("OrgHome"),
      "/chat": this.view("Chat"),
      "/lists": this.view("Lists"),
      "/settings": this.layout("SettingsLayout", {
        "/general": this.view("General"),
        "/billing": this.view("Billing"),
      }),
    }),
    "/live/:orgId": this.layout("LiveLayout", {
      "/chat": this.view("LiveChat"),
      "/lists": this.view("LiveLists"),
      "/nested": this.layout("NestedLayout", {
        "/a": this.view("NestedA"),
        "/b": this.view("NestedB"),
      }),
    }).alwaysRun(),
  };
}

const routes = createFlatViewRoutes({ "/": AppRouter });

function route(
  routePath: keyof typeof routes | string,
  params: Record<string, string> = {},
  search = "",
): PartialRenderRoute {
  const match = routes[routePath];
  if (!match) throw new Error(`No such route: ${routePath}`);
  return { segments: match.segments, params, search };
}

describe("planPartialRender()", () => {
  test("skips a shared layout on a sibling navigation", () => {
    const plan = planPartialRender(
      route("/app/:orgId/chat", { orgId: "A" }),
      route("/app/:orgId/lists", { orgId: "A" }),
    );

    expect(plan).toEqual({ startIndex: 1, carriedViews: ["AppLayout"] });
  });

  test("skips every shared layout in a nested chain", () => {
    const plan = planPartialRender(
      route("/app/:orgId/settings/general", { orgId: "A" }),
      route("/app/:orgId/settings/billing", { orgId: "A" }),
    );

    expect(plan).toEqual({
      startIndex: 2,
      carriedViews: ["AppLayout", "SettingsLayout"],
    });
  });

  test("re-runs the layout when a param it depends on changes", () => {
    const plan = planPartialRender(
      route("/app/:orgId/chat", { orgId: "A" }),
      route("/app/:orgId/lists", { orgId: "B" }),
    );

    expect(plan).toEqual({ startIndex: 0, carriedViews: [] });
  });

  test("re-runs everything when the search string changes", () => {
    const plan = planPartialRender(
      route("/app/:orgId/chat", { orgId: "A" }, "?tab=1"),
      route("/app/:orgId/lists", { orgId: "A" }, "?tab=2"),
    );

    expect(plan).toEqual({ startIndex: 0, carriedViews: [] });
  });

  test("carries the layout when only the search of the leaf is dropped", () => {
    const plan = planPartialRender(
      route("/app/:orgId/chat", { orgId: "A" }, "?tab=1"),
      route("/app/:orgId/lists", { orgId: "A" }, "?tab=1"),
    );

    expect(plan.startIndex).toBe(1);
  });

  test("always runs the leaf, even navigating to the same route", () => {
    const plan = planPartialRender(
      route("/app/:orgId/chat", { orgId: "A" }),
      route("/app/:orgId/chat", { orgId: "A" }),
    );

    expect(plan).toEqual({ startIndex: 1, carriedViews: ["AppLayout"] });
  });

  test("skips nothing without a previous route", () => {
    expect(planPartialRender(null, route("/app/:orgId/chat", { orgId: "A" }))).toEqual({
      startIndex: 0,
      carriedViews: [],
    });
  });

  test("skips nothing when entering a layout from outside it", () => {
    expect(planPartialRender(route("/"), route("/app/:orgId/chat", { orgId: "A" }))).toEqual({
      startIndex: 0,
      carriedViews: [],
    });
  });

  test("skips nothing when leaving a layout", () => {
    expect(planPartialRender(route("/app/:orgId/chat", { orgId: "A" }), route("/"))).toEqual({
      startIndex: 0,
      carriedViews: [],
    });
  });

  test("distinguishes a layout from a view sharing its resolved path", () => {
    // `/app/A` renders [AppLayout, OrgHome], both resolving to `/app/A`. Only
    // the layout may be carried into `/app/A/chat`.
    const plan = planPartialRender(
      route("/app/:orgId", { orgId: "A" }),
      route("/app/:orgId/chat", { orgId: "A" }),
    );

    expect(plan).toEqual({ startIndex: 1, carriedViews: ["AppLayout"] });
  });

  test("distinguishes two layouts mounted on the same path", () => {
    const chat = route("/app/:orgId/chat", { orgId: "A" });

    const impostor = {
      ...chat,
      segments: [{ path: "/app/:orgId", viewPath: "OtherLayout" }, chat.segments[1]],
    };

    expect(planPartialRender(impostor, chat)).toEqual({
      startIndex: 0,
      carriedViews: [],
    });
  });

  test("re-runs a layout that opted out with alwaysRun()", () => {
    const plan = planPartialRender(
      route("/live/:orgId/chat", { orgId: "A" }),
      route("/live/:orgId/lists", { orgId: "A" }),
    );

    expect(plan).toEqual({ startIndex: 0, carriedViews: [] });
  });

  test("alwaysRun() on a layout also re-runs everything below it", () => {
    // Segments are skipped as a prefix, so a nested layout under an opted-out
    // one cannot be carried on its own.
    const plan = planPartialRender(
      route("/live/:orgId/nested/a", { orgId: "A" }),
      route("/live/:orgId/nested/b", { orgId: "A" }),
    );

    expect(plan).toEqual({ startIndex: 0, carriedViews: [] });
  });

  test("never carries a segment matched by a wildcard", () => {
    const wildcard = {
      segments: [
        { path: "/docs/*", viewPath: "DocsLayout" },
        { path: "/docs/*/edit", viewPath: "Edit" },
      ],
      params: {},
      search: "",
    };

    expect(planPartialRender(wildcard, wildcard)).toEqual({
      startIndex: 0,
      carriedViews: [],
    });
  });
});

describe("resolvePartialRender()", () => {
  const to = route("/app/:orgId/lists", { orgId: "A" });

  function resolve(from: string | null, target = to) {
    return resolvePartialRender({
      flatViewRoutes: routes,
      supportedLocales: ["en-US", "tr-TR"],
      from,
      origin: "https://example.com",
      to: target,
    });
  }

  test("reads the route the client is on out of the header", () => {
    expect(resolve("/app/A/chat")).toEqual({
      startIndex: 1,
      carriedViews: ["AppLayout"],
    });
  });

  test("takes the search from the header, not the target", () => {
    expect(resolve("/app/A/chat?tab=1")).toEqual({
      startIndex: 0,
      carriedViews: [],
    });

    const searching = route("/app/:orgId/lists", { orgId: "A" }, "?tab=1");
    expect(resolve("/app/A/chat?tab=1", searching).startIndex).toBe(1);
  });

  test("ignores a locale segment the client left on the path", () => {
    expect(resolve("/tr-TR/app/A/chat")).toEqual({
      startIndex: 1,
      carriedViews: ["AppLayout"],
    });
  });

  test("renders everything without a header", () => {
    expect(resolve(null)).toEqual({ startIndex: 0, carriedViews: [] });
    expect(resolve("")).toEqual({ startIndex: 0, carriedViews: [] });
  });

  test("renders everything when the header names an unrouted path", () => {
    expect(resolve("/nope/not/a/route")).toEqual({
      startIndex: 0,
      carriedViews: [],
    });
  });

  test("renders everything when the header is not a path at all", () => {
    expect(resolve("http://elsewhere.example/app/A/chat").startIndex).toBe(0);
    expect(resolve("://").startIndex).toBe(0);
  });
});
