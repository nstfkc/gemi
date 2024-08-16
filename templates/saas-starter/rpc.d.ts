import "gemi/client";

import Api from "@/app/http/router/api";
import View from "@/app/http/router/view";
import type { CreateRPC } from "gemi/http";
import type { CreateViewRPC } from "gemi/http";

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
  export interface ViewRPC extends CreateViewRPC<View> {}
}
