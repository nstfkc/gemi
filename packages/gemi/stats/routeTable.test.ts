import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { ViewRouter } from "../http/ViewRouter";
import { ApiRouter } from "../http/ApiRouter";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { ServiceProvider } from "../support/ServiceProvider";
import { collectRouteTable } from "./routeTable";

process.env.SECRET ??= "route-table-test-secret";

class Api extends ApiRouter {
  routes = {};
}

class Docs extends ViewRouter {
  routes = {
    "/": this.view("docs/Index"),
    "/:slug": this.view("docs/Page").static(),
  };
}

class RootViews extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/p/:slug": this.view("site/Page").static({ layout: "site/SiteLayout" }),
    "/app": this.layout("app/AppLayout", {
      "/": this.view("app/Dashboard"),
      "/settings": this.view("app/Settings"),
    }),
    "/docs": Docs,
    "/logo.svg": this.file(() => new File(["x"], "logo.svg")),
    "/old": this.redirect(() => "/"),
  };
}

class AdminViews extends ViewRouter {
  routes = {
    "/": this.view("admin/Home"),
  };
}

let booted = false;
class WatchBoot extends ServiceProvider {
  boot() {
    booted = true;
  }
}

class TestKernel extends Kernel {
  providers = [WatchBoot];
  config = {
    route: {
      api: { rootRouter: Api },
      view: { root: createRoot(() => createElement("div")), rootRouter: RootViews },
      domains: {
        root: "gemi.dev",
        groups: [
          { subdomain: "admin", view: { rootRouter: AdminViews } },
          // Reuses the root's view routes: not listed twice.
          { subdomain: ":tenant" },
        ],
      },
    },
  };
}

describe("collectRouteTable", () => {
  const kernel = new TestKernel();
  kernel.boot();
  const table = collectRouteTable(kernel);
  const byPath = (group: string, path: string) =>
    table.find((entry) => entry.group === group && entry.path === path);

  test("lists document routes with their view chain", () => {
    expect(byPath("", "/")).toEqual({ path: "/", group: "", views: ["Home"] });
    expect(byPath("", "/app/settings")).toEqual({
      path: "/app/settings",
      group: "",
      views: ["app/AppLayout", "app/Settings"],
    });
    expect(byPath("", "/docs")?.views).toEqual(["docs/Index"]);
  });

  test("marks static routes and their document layout", () => {
    expect(byPath("", "/p/:slug")).toEqual({
      path: "/p/:slug",
      group: "",
      views: ["site/Page"],
      static: { layout: "site/SiteLayout" },
    });
    expect(byPath("", "/docs/:slug")?.static).toEqual({});
  });

  test("leaves out file and redirect routes", () => {
    expect(byPath("", "/logo.svg")).toBeUndefined();
    expect(byPath("", "/old")).toBeUndefined();
  });

  test("includes other host groups once", () => {
    expect(byPath("admin", "/")?.views).toEqual(["admin/Home"]);
    expect(table.filter((entry) => entry.group === ":tenant")).toEqual([]);
  });

  test("does not boot the providers", () => {
    expect(booted).toBe(false);
  });
});
