import "gemi/client";
import "gemi/http";

import Api from "@/app/http/routes/api";
import View from "@/app/http/routes/view";

import type { CreateRPC } from "gemi/http";
import type { CreateViewRPC } from "gemi/http";
import { type Dictionary } from "./app/i18n";

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
  export interface ViewRPC extends CreateViewRPC<View> {}
  export interface I18nDictionary extends Dictionary {}
}
