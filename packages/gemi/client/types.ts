import { UnwrapPromise } from "@prisma/client/runtime/library";
import type { ViewHandler } from "../http";
import type { ViewRPC } from "./rpc";

type ComponentBranch = [string, ComponentBranch[]];
export type ComponentTree = ComponentBranch[];

export type ViewProps<T extends keyof ViewRPC> =
  ViewRPC[T] extends ViewHandler<infer I, infer O, infer P>
    ? UnwrapPromise<O>
    : never;
