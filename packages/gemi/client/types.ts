import type { PropsWithChildren } from "react";
import type { ViewHandler } from "../http";
import type { Prettify, UnwrapPromise } from "../utils/type";
import type { ViewRPC } from "./rpc";

type ComponentBranch = [string, ComponentBranch[]];
export type ComponentTree = ComponentBranch[];

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
  : T extends `${infer _Start}/:${infer Param}?/${infer Rest}`
    ? { [K in Param]?: string | number } & UrlParser<`/${Rest}`>
    : T extends `${infer _Start}/:${infer Param}/${infer Rest}`
      ? { [K in Param]: string | number } & UrlParser<`/${Rest}`>
      : T extends `${infer _Start}/:${infer Param}`
        ? { [K in Param]: string | number }
        : Record<string, never>;

export type UrlParser<T extends string> = Prettify<UrlParserInternal<T>>;
