import "gemi/client";
import "gemi/http";

import Api from "@/app/http/router/api";
import View from "@/app/http/router/view";

import type { CreateRPC } from "gemi/http";
import type { CreateViewRPC } from "gemi/http";
import { type Dictionary } from "./app/i18n";

type X = CreateRPC<Api>;

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
  export interface ViewRPC extends CreateViewRPC<View> {}
  export interface I18nDictionary extends Dictionary {}
}
