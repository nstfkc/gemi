import { flattenComponentTree } from "../../client/helpers/flattenComponentTree";
import { ComponentTree } from "../../client/types";
import { ViewRoutes } from "../../http/ViewRouter";
import { ServiceProvider } from "../ServiceProvider";
import { createComponentTree } from "./createComponentTree";
import {
  createFlatViewRoutes,
  type FlatViewRoutes,
} from "./createFlatViewRoutes";
import { createRouteManifest } from "./createRouteManifest";

export class ViewRouterServiceProvider extends ServiceProvider {
  flatViewRoutes: FlatViewRoutes = {};
  routeManifest: Record<string, string[]> = {};
  componentTree: ComponentTree = [];
  flatComponentTree: string[] = [];
  RootLayout: any = null;
  boot(routes: ViewRoutes, RootLayout: any) {
    this.flatViewRoutes = createFlatViewRoutes(routes);
    this.routeManifest = createRouteManifest(routes);
    this.componentTree = createComponentTree(routes);
    this.flatComponentTree = flattenComponentTree(this.componentTree);
    this.RootLayout = RootLayout;
  }
}
