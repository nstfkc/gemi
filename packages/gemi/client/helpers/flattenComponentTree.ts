import type { ComponentTree } from "../types";

export function flattenComponentTree(componentTree: ComponentTree): string[] {
  let out: string[] = [];
  for (const [root, branches] of componentTree) {
    out.push(root, ...flattenComponentTree(branches).flat());
  }
  return Array.from(new Set(out));
}
