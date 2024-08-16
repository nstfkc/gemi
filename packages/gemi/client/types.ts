import type { ViewHandler } from "../http";
import type { UnwrapPromise } from "../utils/type";
import type { ViewRPC } from "./rpc";

type ComponentBranch = [string, ComponentBranch[]];
export type ComponentTree = ComponentBranch[];

type ViewKeys = keyof ViewRPC;

export type ViewProps<T extends ViewKeys> =
  ViewRPC[T] extends ViewHandler<any, infer O, any> ? UnwrapPromise<O> : never;
