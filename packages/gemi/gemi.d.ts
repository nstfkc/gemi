import type Api from "@/app/http/routes/api";
import type View from "@/app/http/routes/view";
import type AppFeatures from "@/app/features";

import type { CreateRPC } from "gemi/http";
import type { CreateViewRPC } from "gemi/http";
import type { CreateFeatures } from "gemi/http";
import type { CreateI18nDictionary } from "gemi/client";
import I18nComponents from "@/app/i18n";

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
  export interface ViewRPC extends CreateViewRPC<View> {}
  export interface I18nDictionary extends CreateI18nDictionary<
    typeof I18nComponents
  > {}
  // `InstanceType<typeof …>` because the default export is the class, and
  // `CreateFeatures` walks an *instance*'s `features` field. Passing the
  // constructor resolves `T["features"]` against the static side, which has no
  // such property — so the map comes back empty and every flag key silently
  // becomes an untyped string.
  export interface Features extends CreateFeatures<InstanceType<typeof AppFeatures>> {}
}
