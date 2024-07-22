import "gemi/client";

import Api from "@/app/http/router/api";
import { CreateRPC, ApiRouterHandler } from "gemi/http/ApiRouter";

type A = CreateRPC<Api>;

type QueryOptions<T> =
  T extends ApiRouterHandler<any, any, infer Params>
    ? Params extends Record<string, any>
      ? Options<Params>
      : never
    : never;

type T = QueryOptions<CreateRPC<Api>["GET:/posts/:id"]>;

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
}
