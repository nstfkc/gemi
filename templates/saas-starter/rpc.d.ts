import "gemi/client";

import Api from "@/app/http/router/api";
import View from "@/app/http/router/view";
import type { CreateRPC } from "gemi/http";
import type { CreateViewRPC } from "gemi/http";

type VR = CreateViewRPC<View>;
type Keys<T> = T extends keyof VR
  ? T extends `layout:${string}`
    ? T
    : never
  : never;

type ViewKeys = Keys<keyof VR>;

type ViewProps<T extends ViewKeys> = VR[T] extends (props: infer P) => any
  ? P
  : never;

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
  export interface ViewRPC extends CreateViewRPC<View> {}
}
