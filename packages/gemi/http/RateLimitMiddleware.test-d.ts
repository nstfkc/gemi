import { expectTypeOf, test } from "vitest";

import { HttpRequest } from "./HttpRequest";
import { type RateLimitMiddlewareConfig, clientIp } from "./RateLimitMiddleware";

class SubmitRequest extends HttpRequest<{ form?: string }, { siteSlug: string }> {}

test("clientIp takes a controller's typed request (#1053)", () => {
  const req = new SubmitRequest(new Request("http://gemi.dev/"));

  expectTypeOf(clientIp(req)).toEqualTypeOf<string>();
  expectTypeOf(clientIp(new HttpRequest(new Request("http://gemi.dev/")))).toEqualTypeOf<string>();
});

test("a rate-limit key may annotate a typed request (#1053)", () => {
  const config: RateLimitMiddlewareConfig = {
    key: (req: HttpRequest<{ form?: string }, { siteSlug: string }>) => `${req.params.siteSlug}:${clientIp(req)}`,
  };
  expectTypeOf(config).toMatchTypeOf<RateLimitMiddlewareConfig>();
});
