import { ComponentTree } from "../client/types";
import { ViewChildren } from "../http/ViewRouter";

export function createComponentTree(routes: ViewChildren): ComponentTree {
  const componentTree: ComponentTree = [];

  for (const [_, routeHandler] of Object.entries(routes)) {
    if ("prepare" in routeHandler) {
      const { viewPath, children } = routeHandler.prepare();
      if (Object.entries(children).length > 0) {
        const branch = createComponentTree(children);
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
