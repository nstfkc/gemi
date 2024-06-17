import type { ComponentTree } from "../types";

export function flattenComponentTree(componentTree: ComponentTree) {
  const out = [];
  for (const section of componentTree.flat()) {
    if (typeof section === "string") {
      out.push(section);
    } else {
      for (const [key, value] of Object.entries(section)) {
        out.push(key);
        out.push(...flattenComponentTree(value));
      }
    }
  }
  return out;
}
