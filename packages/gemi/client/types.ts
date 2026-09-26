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
 * Tupled on both sides to answer for `P` as a whole rather than distributing
 * over it. That is defensive rather than load-bearing: for every union reachable
 * here the two spellings agree — all-declared distributes to `true | true`, and
 * a mixed union to `boolean`, which fails `extends true` exactly as the tupled
 * form fails. The tuple is kept because it is the spelling that stays correct
 * if `ViewPaths` ever gains a member that distribution would split, and because
 * `never` is the one input where they already differ. No test pins it; a test
 * that claimed to would be asserting a distinction this app cannot make.
 */
export type IsViewPath<P extends string> = [P] extends [ViewPaths] ? true : false;
