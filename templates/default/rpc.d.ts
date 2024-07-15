import "gemi/client";

import Api from "@/app/http/router/api";

type Routes = Api["routes"];

declare module "gemi/client" {
  export interface QueryInput {
    "/orders/:orderId": { orderId: string };
    "/orders": never;
    "/users/:userId": { userId: string };
  }
}
