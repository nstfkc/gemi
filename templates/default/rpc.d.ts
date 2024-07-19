import "gemi/client";

import Api from "@/app/http/router/api";
import { CreateRPC } from "gemi/http/ApiRouter";

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
}
