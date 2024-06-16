import path from "node:path";
import type { ComponentTree } from "../client/types";

export default async function () {
  const { app } = await import(path.resolve("./app/bootstrap.ts"));

  const entries = app.getComponentTree();

  function getEntries(componentTree: ComponentTree) {
    const out: string[] = [];
    if (!componentTree) {
      return out;
    }

    for (const branch of componentTree) {
      if (typeof branch === "string") {
        out.push(branch);
      } else if (Array.isArray(branch)) {
        out.push(...branch);
      } else {
        const [[first, rest]] = Object.entries(branch);
        out.push(first, ...getEntries(rest));
      }
    }
    return Array.from(new Set(out));
  }

  Bun.write(
    "./.gemi/rollupInput.json",
    JSON.stringify(
      [
        "/app/client.tsx",
        "/app/views/RootLayout.tsx",
        ...getEntries(entries).map((item) => `/app/views/${item}.tsx`),
      ],
      null,
      2,
    ),
  );
}
