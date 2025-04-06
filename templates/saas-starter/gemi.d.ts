import type Api from "@/app/http/routes/api";
import type View from "@/app/http/routes/view";

import type { CreateRPC } from "gemi/http";
import type { CreateViewRPC } from "gemi/http";

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
  export interface ViewRPC extends CreateViewRPC<View> {}
}
