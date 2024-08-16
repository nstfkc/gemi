import { type AuthApiRouter } from "../auth/AuthenticationServiceProvider";
import {
  ViewRouter,
  type ViewHandler,
  type CreateViewRPC,
} from "../http/ViewRouter";
import type { CreateRPC } from "../http/ApiRouter";

class V extends ViewRouter {}

export interface RPC extends CreateRPC<AuthApiRouter> {}

export interface ViewRPC {}

export type ViewProps<T extends keyof ViewRPC> =
  ViewRPC[T] extends ViewHandler<infer I, infer O, infer P> ? O : never;
