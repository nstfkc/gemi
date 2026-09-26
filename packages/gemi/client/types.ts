import type { PropsWithChildren } from "react";
import type { ViewHandler } from "../http";
import type { Prettify, UnwrapPromise } from "../utils/type";
import type { ViewRPC } from "./rpc";

type ComponentBranch = [string, ComponentBranch[]];
export type ComponentTree = ComponentBranch[];

type RemoveDoubleSlash<T extends string> = T extends `${infer P}//${infer S}`
  ? RemoveDoubleSlash<`${P}/${S}`>
  : T;

export type RemoveGroupPrefix<T extends string> =
  T extends `${infer P}(${string})${infer S}`
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
 * Not a permissive fallback like `FeatureKey`'s, and deliberately so: widening
 * it to `string` there would widen `Link`, `Redirect` and `Url.absolute` with
 * it. A component in a shared package typed `to: ViewPaths` compiles and then
 * fails at every call site against `never`.
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

type ViewKeys<T> = T extends keyof ViewRPC
  ? T extends `view:${infer K}`
    ? K
    : never
  : never;

type LayoutKeys<T> = T extends keyof ViewRPC
  ? T extends `layout:${infer K}`
    ? K
    : never
  : never;

export type ViewProps<T extends ViewKeys<keyof ViewRPC>> =
  ViewRPC[`view:${T}`] extends ViewHandler<any, infer O, any>
    ? Prettify<UnwrapPromise<O>>
    : never;

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
