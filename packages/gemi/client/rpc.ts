import {
  type AuthApiRouter,
  type AuthViewRouter,
} from "../auth/AuthenticationServiceProvider";
import type { CreateRPC } from "../http/ApiRouter";
import type { CreateViewRPC } from "../http/ViewRouter";

export interface RPC extends CreateRPC<AuthApiRouter, "/auth"> {}

export interface ViewRPC extends CreateViewRPC<AuthViewRouter, "/auth"> {}

export interface I18nDictionary {}
