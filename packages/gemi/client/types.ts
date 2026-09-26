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
 * Distributing, not tupled, and that is the whole of what it buys over the
 * obvious spelling. `[any] extends [ViewPaths]` is an ordinary assignability
 * check with no special rule for `any`, so it answers `true` — and
 * `UrlParser<any>` takes its `string extends T` arm and reports every route's
 * params as required. An `any`-typed path therefore hit the exact `TS2554` this
 * type exists to remove: `JSON.parse(body).to`, a field off an untyped API
 * response, anything that has lost its type on the way here. Distributing sends
 * `any` down both arms, which resolves to `boolean`, which fails `extends true`
 * — the loose branch, which is the right answer for a path nothing knows
 * anything about.
 *
 * Unions are unaffected, which is why this costs nothing: a union of declared
 * routes distributes to `true | true`, and a mixed one to `boolean`, exactly as
 * the tupled form answered. `never` distributes to `never`, which also fails
 * `extends true` — and a `never`-typed path is not a call anyone makes.
 */
export type IsViewPath<P extends string> = P extends ViewPaths ? true : false;
