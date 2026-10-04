import type { ComponentTree } from "../../client/types";
import type { ViewRoutes } from "../../http/ViewRouter";

/**
 * Adds `node` to `tree`, folding it into a sibling with the same view path.
 *
 * Several routes can use one view (a legacy path and its replacement, or one
 * layout mounted under two prefixes). The tree describes what can render at
 * each depth, not one entry per route, so a view appears once per level —
 * otherwise `Tree` mounts every copy and the page renders twice (#788). The
 * subtrees of a repeated layout are merged the same way.
 */
function addNode(tree: ComponentTree, node: ComponentTree[number]) {
  const [viewPath, branch] = node;
  const existing = tree.find(([path]) => path === viewPath);
  if (!existing) {
    tree.push([viewPath, [...branch]]);
    return;
  }
  for (const child of branch) {
    addNode(existing[1], child);
  }
}

export function createComponentTree(routes: ViewRoutes): ComponentTree {
  const componentTree: ComponentTree = [];

  for (const [_, routeHandler] of Object.entries(routes)) {
    if ("run" in routeHandler) {
      const viewPath = routeHandler.viewPath;
      if (viewPath === "__") {
        continue;
      }

      // File and redirect routes never resolve to a component.
      if (viewPath === "REDIRECT") {
        continue;
      }

      if (viewPath === "FILE") {
        continue;
      }

      if ("children" in routeHandler) {
        const router = new routeHandler.children();
        const branch = createComponentTree(router.routes);
        addNode(componentTree, [viewPath, branch]);
      } else {
        addNode(componentTree, [viewPath, []]);
      }
    } else {
      const router = new routeHandler();
      const branch = createComponentTree(router.routes);
      for (const node of branch) {
        addNode(componentTree, node);
      }
    }
  }

  return componentTree;
}
