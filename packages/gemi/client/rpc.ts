import { type AuthApiRouter } from "../auth/AuthenticationServiceProvider";
import { CreateRPC } from "../http/ApiRouter";

export interface RPC extends CreateRPC<AuthApiRouter> {}
