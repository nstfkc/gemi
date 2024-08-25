import path from "node:path";
import type { ComponentTree } from "../client/types";
import { flattenComponentTree } from "../client/helpers/flattenComponentTree";

export default async function () {
  const { app } = await import(path.resolve("./app/bootstrap.ts"));

  const entries = app.getComponentTree();

  function getEntries(componentTree: ComponentTree) {
    const out: string[] = ["/app/client.tsx"];
    if (!componentTree) {
      return out;
    }

    return Array.from(new Set(flattenComponentTree(componentTree)));
  }

  return Array.from(
    new Set([
      "/app/client.tsx",
      ...getEntries(entries).map((item) => `/app/views/${item}.tsx`),
    ]),
  );
}
