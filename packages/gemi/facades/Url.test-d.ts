/**
 * Type-level tests for `Url.api`, `Url.apiAbsolute` and `Url.matchApi` (#994).
 * The paths come from the app's routes; inside gemi that is its own auth
 * router, and `ApiPathsOf` is checked against a router built here.
 */
import { describe, expectTypeOf, test } from "vitest";

import type { ApiPathsOf } from "../client/types";
import { ApiRouter, type CreateFileRPC, type CreateRPC } from "../http/ApiRouter";
import { Url } from "./Url";

class Pages extends ApiRouter {
  routes = {
    "/:pageId/files/:fileId": this.stream(() => null),
    "/:pageId": this.get(() => ({})),
  };
}

class Api extends ApiRouter {
  routes = {
    "/pages": Pages,
    "/form/:formId": this.post(() => ({})),
    "/designer-files/:fileId": this.file(() => null),
    "/me": { get: this.get(() => ({})), put: this.put(() => ({})) },
  };
}

describe("ApiPathsOf", () => {
  test("every api route and file route's path, without its method", () => {
    expectTypeOf<ApiPathsOf<CreateRPC<Api>, CreateFileRPC<Api>>>().toEqualTypeOf<
      | "/pages/:pageId/files/:fileId"
      | "/pages/:pageId"
      | "/form/:formId"
      | "/designer-files/:fileId"
      | "/me"
    >();
  });
});

describe("Url.api", () => {
  test("takes the app's api paths", () => {
    expectTypeOf(Url.api("/auth/me")).toEqualTypeOf<string>();
    expectTypeOf(Url.apiAbsolute("/auth/me")).toEqualTypeOf<string>();
    // @ts-expect-error not a route
    Url.api("/auth/not-a-route");
    // @ts-expect-error a path without params takes none
    Url.api("/auth/me", { id: "1" });
  });

  test("matchApi answers string params or null", () => {
    expectTypeOf(Url.matchApi("/auth/me", "/api/auth/me")).toEqualTypeOf<{} | null>();
  });
});
