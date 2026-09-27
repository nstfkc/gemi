import type { PropsWithChildren } from "react";
import type { ViewHandler } from "../http";
import type { Prettify, UnwrapPromise } from "../utils/type";
import type { ViewRPC } from "./rpc";

type ComponentBranch = [string, ComponentBranch[]];
export type ComponentTree = ComponentBranch[];

type RemoveDoubleSlash<T extends string> = T extends `${infer P}//${infer S}`
  ? RemoveDoubleSlash<`${P}/${S}`>
  : T;

export type RemoveGroupPrefix<T extends string> = T extends `${infer P}(${string})${infer S}`
  ? RemoveDoubleSlash<`${P}${S}`>
  : T;

/**
 * Every view path the application declares — what `Link`, `Redirect`,
 * `useNavigate`, `usePrefetch` and `Url` take.
 *
 * Exported since 0.65, because `Link` is overloaded and therefore has no single
 * `ComponentProps` to derive this from, and the map behind it is internal.
 *
 * TWO THINGS A CALLER WILL MEET. It is **`never`** in any file where the app's
 * route augmentation does not resolve — a shared package in a monorepo, an app
 * on a `src/` layout or a different alias, a playground; `gemi.d.ts` lists them.
 * Not a permissive fallback like `FeatureKey`'s, and deliberately so: widening it
 * to `string` would widen `Redirect`, `useNavigate`, `usePrefetch` and
 * `Url.absolute`, which are typed against this. (`Link` would not move — it is
 * typed against a private map in `Link.tsx` and never names this type. Nothing
 * asserts the other direction, either: a route added to that private map would
 * be accepted by `Link` and absent from this union, and the template's type test
 * cannot see it, because `LinkProps<T>["href"]` is `T` by construction.)
 * A component in a shared package typed `to: ViewPaths` compiles and then fails
 * at every call site against `never`.
 *
 * And its members are route **patterns**: `/orgs/:orgId/reports` is one. They go
 * where a path pattern goes, alongside the `params` that fill it in — not into
 * an `href`.
 */
export type ViewPaths = ViewKeys<keyof ViewRPC>;

export type ViewResult<T extends keyof ViewRPC> =
  ViewRPC[T] extends ViewHandler<infer I, infer O, infer P>
    ? { input: I; output: O; params: P }
    : never;

export type ViewRoute = keyof ViewRPC;

type ViewKeys<T> = T extends keyof ViewRPC ? (T extends `view:${infer K}` ? K : never) : never;

type LayoutKeys<T> = T extends keyof ViewRPC ? (T extends `layout:${infer K}` ? K : never) : never;

export type ViewProps<T extends ViewKeys<keyof ViewRPC>> =
  ViewRPC[`view:${T}`] extends ViewHandler<any, infer O, any> ? Prettify<UnwrapPromise<O>> : never;

export type LayoutProps<T extends LayoutKeys<keyof ViewRPC>> =
  ViewRPC[`layout:${T}`] extends ViewHandler<any, infer O, any>
    ? PropsWithChildren<UnwrapPromise<O>>
    : never;

type UrlParserInternal<T extends string> = string extends T
  ? Record<string, string>
  : T extends `${infer _Start}/:${infer Param}*/${infer Rest}`
    ? { [K in Param]: string[] } & UrlParserInternal<`/${Rest}`>
    : T extends `${infer _Start}/:${infer Param}?/${infer Rest}`
      ? { [K in Param]?: string | number } & UrlParserInternal<`/${Rest}`>
      : T extends `${infer _Start}/:${infer Param}/${infer Rest}`
        ? { [K in Param]: string | number } & UrlParserInternal<`/${Rest}`>
        : T extends `${infer _Start}/:${infer Param}*`
          ? { [K in Param]: string }
          : T extends `${infer _Start}/:${infer Param}?`
            ? { [K in Param]?: string | number }
            : T extends `${infer _Start}/:${infer Param}`
              ? { [K in Param]: string | number }
              : Record<string, never>;

export type UrlParser<T extends string> = Prettify<UrlParserInternal<T>>;

/**
 * Whether `P` is one of the app's declared view routes, or a URL the app built
 * at runtime.
 *
 * `push`, `replace` and the prefetcher all take `ViewPaths | (string & {})`:
 * a route pattern, whose `:params` they substitute, or an already-built path,
 * which has none left to substitute. Which of the two decides whether an
 * `options` argument carrying `params` is required, and the naive spelling
 * gets that wrong in a way that only appears once an app declares its first
 * param route.
 *
 * The naive spelling is `<T extends ViewPaths>(path: T | (string & {}), ...)`.
 * Pass a plain `string` and there is no candidate to infer `T` from — `string`
 * does not satisfy `ViewPaths` — so it falls back to its constraint, the union
 * of *every* route in the app. `UrlParser` distributes over that union, one
 * member of it has a param, and a union is only assignable to
 * `Record<string, never>` if every member is. So `params` became mandatory for
 * every runtime string, and the fix for the caller was to pass params that name
 * nothing. An app with no param routes never saw it, which is why this survived
 * as long as it did.
 *
 * Distributing, not tupled, and that is the whole of what it buys over the
 * obvious spelling. `[any] extends [ViewPaths]` is an ordinary assignability
 * check with no special rule for `any`, so it answers `true` — and
 * `UrlParser<any>` takes its `string extends T` arm, which is
 * `Record<string, string>`: not assignable to `Record<string, never>`, so the
 * required-options branch is chosen. An `any`-typed path therefore hit the exact
 * `TS2554` this type exists to remove: `JSON.parse(body).to`, a field off an
 * untyped API response, anything that has lost its type on the way here.
 * Distributing sends `any` down both arms, which resolves to `boolean`, which
 * fails `extends true` — the loose branch, which is the right answer for a path
 * nothing knows anything about.
 *
 * Unions are unaffected, which is why this costs nothing. A union of declared
 * routes distributes to `true | true` and the tupled form answers `true`; a mixed
 * one distributes to `boolean` and the tupled form answers `false`. Different
 * types, same branch — only `extends true` is asked, and neither satisfies it.
 *
 * Measured, so the comment does not have to be believed: `any` is the ONLY input
 * the two spellings disagree on. Distributing gives it the loose branch and
 * tupling gives it the strict one. `never` takes the strict branch either way —
 * `P extends ViewPaths` over `never` is `never`, and `never extends true` is
 * satisfied — which is wrong in the same way and does not matter, because a
 * `never`-typed path is not a call anyone makes.
 */
export type IsViewPath<P extends string> = P extends ViewPaths ? true : false;
