import path from "node:path";
import type { ComponentTree } from "../client/types";
import { flattenComponentTree } from "../client/helpers/flattenComponentTree";

export default async function () {
  const { app } = await import(path.resolve("./app/bootstrap.ts"));

  const entries = app.getComponentTree();

  function getEntries(componentTree: ComponentTree) {
    const out: string[] = [];
    if (!componentTree) {
      return out;
    }

    return Array.from(new Set(flattenComponentTree(componentTree)));
  }

  Bun.write(
    "./.gemi/rollupInput.json",
    JSON.stringify(
      [
        "/app/client.tsx",
        ...getEntries(entries).map((item) => `/app/views/${item}.tsx`),
      ],
      null,
      2,
    ),
  );
}
