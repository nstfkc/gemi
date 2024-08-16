import type { PropsWithChildren } from "react";
import type { ViewHandler } from "../http";
import type { UnwrapPromise } from "../utils/type";
import type { ViewRPC } from "./rpc";

type ComponentBranch = [string, ComponentBranch[]];
export type ComponentTree = ComponentBranch[];

export type ViewPaths = ViewKeys<keyof ViewRPC>;

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
    ? UnwrapPromise<O>
    : never;

export type LayoutProps<T extends LayoutKeys<keyof ViewRPC>> =
  ViewRPC[`layout:${T}`] extends ViewHandler<any, infer O, any>
    ? PropsWithChildren<UnwrapPromise<O>>
    : never;

export type UrlParser<T extends string> = string extends T
  ? Record<string, string>
  : T extends `${infer _Start}/:${infer Param}?/${infer Rest}`
    ? { [K in Param]?: string } & UrlParser<`/${Rest}`>
    : T extends `${infer _Start}/:${infer Param}/${infer Rest}`
      ? { [K in Param]: string } & UrlParser<`/${Rest}`>
      : T extends `${infer _Start}/:${infer Param}`
        ? { [K in Param]: string }
        : never;
