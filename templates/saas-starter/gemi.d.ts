import type Api from "@/app/http/routes/api";
import type View from "@/app/http/routes/view";

import type { CreateRPC } from "gemi/http";
import type { CreateViewRPC } from "gemi/http";
import type { CreateI18nDictionary } from "gemi/client";
import I18nComponents from "@/app/i18n";

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
  export interface ViewRPC extends CreateViewRPC<View> {}
  export interface I18nDictionary
    extends CreateI18nDictionary<typeof I18nComponents> {}
}
