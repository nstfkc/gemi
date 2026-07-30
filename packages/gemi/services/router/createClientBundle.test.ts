import { describe, test, expect } from "vitest";
import { ViewRouter } from "../../http/ViewRouter";
import { createRouteManifest } from "./createRouteManifest";
import { createComponentTree } from "./createComponentTree";
import { createFlatViewRoutes } from "./createFlatViewRoutes";
import {
  collectVisibleViews,
  createClientBundle,
  pruneComponentTree,
  serializeViewLoaders,
  type ClientBundle,
} from "./createClientBundle";

class AppRouter extends ViewRouter {
  middlewares = ["auth"];
  routes = {
    "/": this.layout("AppLayout", {
      "/dashboard": this.view("Dashboard"),
      "/inbox": this.view("Inbox"),
    }),
  };
}

class MixedRouter extends ViewRouter {
  routes = {
    "/": this.layout("SettingsLayout", {
      "/help": this.view("Help"),
      "/billing": this.view("Billing").middleware(["auth"]),
    }),
  };
}

/** Shaped like the saas-starter template: a public tree plus a guarded group. */
class RootRouter extends ViewRouter {
  middlewares = ["cache:public,12840"];
  routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home"),
      "/pricing": this.view("Pricing"),
    }),
    "/settings": MixedRouter,
    "(app)/": AppRouter,
  };
}

/**
 * Stands in for `MiddlewareServiceContainer.isPrivateChain` — this suite is
 * about what gets pruned, not about how a chain is classified (see
 * `isPrivateChain.test.ts` for that).
 */
function buildFull(routes: any) {
  const routeManifest = createRouteManifest(routes);
  const flatViewRoutes = createFlatViewRoutes(routes);
  const hiddenRoutePaths = new Set(
    Object.entries(flatViewRoutes)
      .filter(([, { middleware }]) => middleware.includes("auth"))
      .map(([routePath]) => routePath),
  );

  const full: ClientBundle = {
    routeManifest,
    componentTree: [["404", []], ...createComponentTree(routes)],
    loaders: Object.fromEntries(
      ["404", "PublicLayout", "Home", "Pricing", "SettingsLayout", "Help", "Billing", "AppLayout", "Dashboard", "Inbox"].map(
        (view) => [view, `/app/views/${view}.tsx`],
      ),
    ),
  };

  return { full, hiddenRoutePaths };
}

describe("createClientBundle()", () => {
  test("hiding by route path lines up with the manifest's keys", () => {
    const { hiddenRoutePaths, full } = buildFull({ "/": RootRouter });

    // If these two ever drifted, hiding would silently do nothing.
    expect(hiddenRoutePaths).toEqual(new Set(["/dashboard", "/inbox", "/settings/billing"]));
    for (const routePath of hiddenRoutePaths) {
      expect(full.routeManifest).toHaveProperty([routePath]);
    }
  });

  test("a layout whose children are all private disappears entirely", () => {
    const { full, hiddenRoutePaths } = buildFull({ "/": RootRouter });
    const bundle = createClientBundle(full, hiddenRoutePaths);

    expect(Object.keys(bundle.routeManifest).sort()).toEqual([
      "/",
      "/pricing",
      "/settings/help",
    ]);
    // AppLayout only ever reached the manifest through /dashboard and /inbox.
    expect(bundle.componentTree).toEqual([
      ["404", []],
      [
        "PublicLayout",
        [
          ["Home", []],
          ["Pricing", []],
        ],
      ],
      ["SettingsLayout", [["Help", []]]],
    ]);
    expect(bundle.loaders).not.toHaveProperty("AppLayout");
    expect(bundle.loaders).not.toHaveProperty("Dashboard");
    expect(bundle.loaders).not.toHaveProperty("Billing");
  });

  test("a layout with mixed children keeps only its public chains", () => {
    const { full, hiddenRoutePaths } = buildFull({ "/": RootRouter });
    const bundle = createClientBundle(full, hiddenRoutePaths);

    expect(bundle.routeManifest["/settings/help"]).toEqual(["SettingsLayout", "Help"]);
    expect(bundle.loaders).toHaveProperty("SettingsLayout");
    expect(bundle.loaders).toHaveProperty("Help");
  });

  test("`404` stays reachable even though no route points at it", () => {
    const { full, hiddenRoutePaths } = buildFull({ "/": RootRouter });
    const bundle = createClientBundle(full, hiddenRoutePaths);

    expect(bundle.componentTree[0]).toEqual(["404", []]);
    expect(bundle.loaders["404"]).toBe("/app/views/404.tsx");
  });

  test("an app with no private routes gets the identical bundle", () => {
    const { full } = buildFull({ "/": RootRouter });

    expect(createClientBundle(full, new Set())).toBe(full);
  });
});

describe("collectVisibleViews()", () => {
  test("flattens every chain and always includes 404", () => {
    expect(
      collectVisibleViews({
        "/": ["Layout", "Home"],
        "/about": ["Layout", "About"],
      }),
    ).toEqual(new Set(["404", "Layout", "Home", "About"]));
  });
});

describe("pruneComponentTree()", () => {
  test("drops a branch as soon as its root view is hidden", () => {
    const tree: any = [
      ["Layout", [["Home", []]]],
      ["AppLayout", [["Dashboard", [["Widget", []]]]]],
    ];

    expect(pruneComponentTree(tree, new Set(["Layout", "Home", "Widget"]))).toEqual([
      ["Layout", [["Home", []]]],
    ]);
  });
});

describe("serializeViewLoaders()", () => {
  test("emits an object literal of dynamic imports", () => {
    expect(serializeViewLoaders({ Home: "/app/views/Home.tsx" })).toBe(
      `{"Home": () => import("/app/views/Home.tsx")}`,
    );
  });

  test("emits a valid empty literal", () => {
    expect(serializeViewLoaders({})).toBe("{}");
  });
});
