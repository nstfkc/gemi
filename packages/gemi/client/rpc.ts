import { type AuthApiRouter } from "../auth/AuthenticationServiceProvider";
import type { CreateRPC } from "../http/ApiRouter";

export interface RPC extends CreateRPC<AuthApiRouter, "/auth"> {}

export interface ViewRPC {}

export interface I18nDictionary {}
