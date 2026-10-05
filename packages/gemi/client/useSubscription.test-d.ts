import { describe, expectTypeOf, test } from "vitest";

import { ApiRouter, type CreateRPC } from "../http/ApiRouter";
import type { HttpRequest } from "../http/HttpRequest";
import type { ChangeFeedResponse } from "../services/change-feed/wire";
import type { UnwrapPromise } from "../utils/type";
import type { ApiRouterHandler } from "../http/ApiRouter";

type SiteChange = { pages: string[] };
declare function stream<T>(req: HttpRequest, channel: string): ChangeFeedResponse<T>;

class Routes extends ApiRouter {
  routes = {
    "/sites/:siteId/changes": this.get(async (req: HttpRequest) =>
      stream<SiteChange>(req, `site:${req.params.siteId}`),
    ),
    "/plain": this.get(() => new Response("x")),
  };
}

type Rpc = CreateRPC<Routes, "">;
// The same derivation `SubscriptionData` makes against the app's own `RPC`.
type DataOf<K extends keyof Rpc> =
  UnwrapPromise<Rpc[K] extends ApiRouterHandler<any, infer D, any> ? D : never> extends ChangeFeedResponse<
    infer T
  >
    ? T
    : unknown;

describe("useSubscription's data type", () => {
  test("comes from the route's ChangeFeed.stream<T>()", () => {
    expectTypeOf<DataOf<"GET:/sites/:siteId/changes">>().toEqualTypeOf<SiteChange>();
  });

  test("is unknown for a route answering a plain Response", () => {
    expectTypeOf<DataOf<"GET:/plain">>().toEqualTypeOf<unknown>();
  });
});
