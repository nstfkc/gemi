class BroadcastingRouterHandler<Input, Output> {}

type BroadcastingRoutes = Record<
  string,
  BroadcastingRouterHandler<any, any> | BroadcastingRouter
>;

export class BroadcastingRouter {
  routes: BroadcastingRoutes = {};
}
