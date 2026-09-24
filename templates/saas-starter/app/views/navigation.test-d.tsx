import { describe, expectTypeOf, test } from "vitest";

import { Redirect, type ExternalLinkProps, type LinkProps } from "gemi/client";

/**
 * **`Redirect` and the exported link prop types, from inside a real application.**
 *
 * This can only be checked here: `ViewRPC` is augmented by `gemi.d.ts` against
 * `@/app/http/routes/view`, so a test in `packages/gemi` sees no routes at all.
 *
 * `Redirect` used to take `ComponentProps<typeof Link>`, which comes out `{}`
 * since `Link` became overloaded, so `action` was the only prop it accepted
 * (#584).
 */
describe("Redirect", () => {
  test("takes a route path", () => {
    <Redirect action="replace" href="/dashboard" />;
  });

  test("takes the params a parameterised route needs", () => {
    <Redirect action="push" href="/partial/:orgId/reports" params={{ orgId: "acme" }} />;

    // @ts-expect-error — `/partial/:orgId/reports` needs `orgId`.
    <Redirect action="push" href="/partial/:orgId/reports" />;
  });

  test("rejects a path that is not a route", () => {
    // @ts-expect-error — no such route.
    <Redirect action="replace" href="/nowhere" />;
  });

  test("still requires `action`", () => {
    // @ts-expect-error — `action` is missing.
    <Redirect href="/dashboard" />;
  });
});

describe("LinkProps", () => {
  test("derives an href type an app can use", () => {
    type BackHref = LinkProps<"/dashboard">["href"];
    expectTypeOf<BackHref>().toEqualTypeOf<"/dashboard">();
  });

  test("carries a route's params", () => {
    expectTypeOf<LinkProps<"/partial/:orgId/reports">["params"]>().toEqualTypeOf<{
      orgId: string | number;
    }>();
  });

  test("the external variant takes an absolute URL, not a path", () => {
    expectTypeOf<ExternalLinkProps["href"]>().not.toEqualTypeOf<string>();
  });
});
