import type { ComponentTree } from "../client/types";
import { join } from "node:path";
import { App } from "../app";

import { flattenComponentTree } from "../client/helpers/flattenComponentTree";

export default async function (appDir: string): Promise<string[]> {
  const { default: Kernel } = await import(join(appDir, "./kernel/Kernel.ts"));

  const app = new App({ kernel: Kernel });
  const entries = app.getComponentTree();

  function getEntries(componentTree: ComponentTree) {
    const out: string[] = ["/app/client.tsx"];
    if (!componentTree) {
      return out;
    }

    return Array.from(new Set(flattenComponentTree(componentTree)));
  }

  return Array.from(
    new Set(["/app/client.tsx", ...getEntries(entries).map((item) => `/app/views/${item}.tsx`)]),
  );
}
