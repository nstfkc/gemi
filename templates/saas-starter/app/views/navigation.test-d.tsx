import { describe, expectTypeOf, test } from "vitest";

import { Redirect, type ExternalLinkProps, type LinkProps, type ViewPaths } from "gemi/client";

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

describe("ViewPaths", () => {
  test("names the app's own routes, and nothing else", () => {
    // Asserted against a real route rather than `not.toEqualTypeOf<never>()`,
    // for the reason the `ExternalLinkProps` test below gives: a negative
    // assertion passes for the wrong reasons.
    expectTypeOf<"/dashboard">().toExtend<ViewPaths>();
    expectTypeOf<"/partial/:orgId/reports">().toExtend<ViewPaths>();

    // @ts-expect-error — no such route.
    const nowhere: ViewPaths = "/nowhere";
    void nowhere;
  });

  test("is the domain Link accepts, in both directions, so the two cannot drift", () => {
    // `toEqualTypeOf` alone pins only that `ViewPaths` is no WIDER than what
    // `Link` takes. `Link` is typed against a private map rather than against
    // `ViewPaths`, so it could gain a route this union does not name and nothing
    // would notice — which is the drift worth watching.
    expectTypeOf<LinkProps<ViewPaths>["href"]>().toEqualTypeOf<ViewPaths>();
    expectTypeOf<ViewPaths>().toExtend<LinkProps<ViewPaths>["href"]>();
    expectTypeOf<LinkProps<ViewPaths>["href"]>().toExtend<ViewPaths>();
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
    // Naming the type it must be, rather than one it must not: `not
    // .toEqualTypeOf<string>()` also passed for `string | number`, so it only
    // ever caught `href` widening to exactly `string`.
    expectTypeOf<ExternalLinkProps["href"]>().toEqualTypeOf<
      `http://${string}` | `https://${string}`
    >();
  });
});
