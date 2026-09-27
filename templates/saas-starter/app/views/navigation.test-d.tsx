import { describe, expectTypeOf, test } from "vitest";

import {
  Redirect,
  useIntendedUrl,
  useNavigate,
  usePrefetch,
  type ExternalLinkProps,
  type LinkProps,
  type ViewPaths,
} from "gemi/client";

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

/**
 * **`push`, `replace` and the prefetcher over both kinds of path.**
 *
 * Like `Redirect` above, only checkable from inside an application — and, more
 * to the point, only from one that declares a route with a param. That is what
 * made the bug below ship: `packages/gemi` compiles against a stub app with no
 * routes, where every one of these assertions collapses to the same answer.
 *
 * `push(useIntendedUrl(...))` is the usage `useIntendedUrl`'s own docblock
 * recommends, and it stopped compiling the moment an app declared its first
 * parameterised route — `TS2554: Expected 2 arguments, but got 1`. The value is
 * a concrete, already-validated path; there is nothing left to substitute into
 * it, so there is nothing to pass.
 */
describe("useNavigate over a runtime-built path", () => {
  test("takes a concrete path with no options, as useIntendedUrl documents", () => {
    const { push, replace } = useNavigate();
    const intended = useIntendedUrl("/");
    push(intended);
    replace(intended);
  });

  test("and still takes the options that do apply to one", () => {
    const { push } = useNavigate();
    push(useIntendedUrl("/"), { search: { welcome: "1" }, hash: "top", shallow: true });
  });

  test("a pattern held in a string may still carry its params", () => {
    // Indistinguishable from the concrete path above at the type level, and it
    // worked before this, so the options keep an optional `params`.
    const pattern: string = "/partial/:orgId/reports";
    useNavigate().push(pattern, { params: { orgId: "acme" } });
  });

  test("an any-typed path takes the loose branch, rather than TS2554", () => {
    // A path that has lost its type on the way here: a field off an untyped API
    // response, `JSON.parse(...)`, a value through a cast. This was the one
    // surviving mutation in the first round of this PR, and it was not
    // cosmetic — `[any] extends [ViewPaths]` answers `true`, so an `any` path
    // was demanding params for every route in the app.
    const untyped: any = "/dashboard";
    useNavigate().push(untyped);
    usePrefetch()(untyped);
    useNavigate().push(JSON.parse('{"to":"/dashboard"}').to);
  });

  test("the prefetcher agrees, having had the same fault", () => {
    usePrefetch()(useIntendedUrl("/"));
  });
});

describe("useNavigate over a declared route", () => {
  test("requires the params of a parameterised route", () => {
    const { push } = useNavigate();
    push("/partial/:orgId/reports", { params: { orgId: "acme" } });

    // @ts-expect-error — `/partial/:orgId/reports` needs `orgId`.
    push("/partial/:orgId/reports");
  });

  test("requires the right params, not merely some", () => {
    // @ts-expect-error — `orgId` is the param; `org` is not.
    useNavigate().push("/partial/:orgId/reports", { params: { org: "acme" } });
  });

  test("asks for nothing extra from a route without params", () => {
    useNavigate().push("/dashboard");
    usePrefetch()("/dashboard");
  });

  test("a union of parameterised routes still requires them", () => {
    // Both members have the same param, so one `params` satisfies the call.
    // This does not distinguish the tupled test in `IsViewPath` from a
    // distributing one — they agree on every union this app can build — it
    // guards that a union of declared routes keeps taking the strict branch.
    const either: "/partial/:orgId/reports" | "/partial/:orgId/settings/general" =
      "/partial/:orgId/reports";
    useNavigate().push(either, { params: { orgId: "acme" } });

    // @ts-expect-error — still required across the union.
    useNavigate().push(either);
  });

  test("the prefetcher requires them too", () => {
    usePrefetch()("/partial/:orgId/reports", { params: { orgId: "acme" } });

    // @ts-expect-error — `orgId` is missing.
    usePrefetch()("/partial/:orgId/reports");
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
