import type { ComponentTree } from "../../client/types";
import type { ViewRoutes } from "../../http/ViewRouter";

export function createComponentTree(routes: ViewRoutes): ComponentTree {
  const componentTree: ComponentTree = [];

  for (const [_, routeHandler] of Object.entries(routes)) {
    if ("run" in routeHandler) {
      const viewPath = routeHandler.viewPath;
      if ("children" in routeHandler) {
        const router = new routeHandler.children();
        const branch = createComponentTree(router.routes);
        componentTree.push([viewPath, branch]);
      } else {
        componentTree.push([viewPath, []]);
      }
    } else {
      const router = new routeHandler();
      const branch = createComponentTree(router.routes);
      componentTree.push(...branch);
    }
  }

  return componentTree;
}
