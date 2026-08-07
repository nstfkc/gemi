import { describe, expect, test } from "vitest";

import { collectModulePreloads, type ViteManifest } from "./modulePreloads";

/** Shaped like a real `dist/client/.vite/manifest.json`. */
const manifest: ViteManifest = {
  "app/client.tsx": {
    file: "assets/client-DJhrQPW5.js",
    imports: ["_jsx-runtime-DGeXAQPT.js", "_client-Dqbo_yR2.js"],
  },
  "app/views/AppLayout.tsx": {
    file: "assets/AppLayout-CRSTVHPB.js",
    imports: ["_jsx-runtime-DGeXAQPT.js", "_nav-XhWF0QgQ.js"],
    dynamicImports: ["_heavy-modal-Aa11bBcc.js"],
  },
  "_nav-XhWF0QgQ.js": {
    file: "assets/nav-XhWF0QgQ.js",
    imports: ["_icons-BrEMyRB_.js"],
  },
  "_icons-BrEMyRB_.js": { file: "assets/icons-BrEMyRB_.js" },
  "_jsx-runtime-DGeXAQPT.js": { file: "assets/jsx-runtime-DGeXAQPT.js" },
  "_client-Dqbo_yR2.js": { file: "assets/client-Dqbo_yR2.js" },
  "_heavy-modal-Aa11bBcc.js": { file: "assets/heavy-modal-Aa11bBcc.js" },
};

describe("collectModulePreloads", () => {
  test("returns the chunk itself first, then its static imports transitively", () => {
    expect(collectModulePreloads(manifest, "app/views/AppLayout.tsx")).toEqual([
      "/assets/AppLayout-CRSTVHPB.js",
      "/assets/jsx-runtime-DGeXAQPT.js",
      "/assets/nav-XhWF0QgQ.js",
      // Reached through `_nav`, which the browser could not have discovered
      // before that chunk arrived and parsed.
      "/assets/icons-BrEMyRB_.js",
    ]);
  });

  test("leaves dynamic imports out — the app asked for those to be lazy", () => {
    expect(collectModulePreloads(manifest, "app/views/AppLayout.tsx")).not.toContain(
      "/assets/heavy-modal-Aa11bBcc.js",
    );
  });

  test("visits a shared chunk once", () => {
    const urls = collectModulePreloads(
      {
        ...manifest,
        "app/views/Both.tsx": {
          file: "assets/Both.js",
          imports: ["_jsx-runtime-DGeXAQPT.js", "_nav-XhWF0QgQ.js", "_jsx-runtime-DGeXAQPT.js"],
        },
      },
      "app/views/Both.tsx",
    );

    expect(urls.filter((url) => url === "/assets/jsx-runtime-DGeXAQPT.js")).toHaveLength(1);
  });

  test("terminates on a cyclic chunk graph", () => {
    const cyclic: ViteManifest = {
      "_a.js": { file: "assets/a.js", imports: ["_b.js"] },
      "_b.js": { file: "assets/b.js", imports: ["_a.js"] },
    };

    expect(collectModulePreloads(cyclic, "_a.js")).toEqual(["/assets/a.js", "/assets/b.js"]);
  });

  test("is empty for a view with no built chunk", () => {
    expect(collectModulePreloads(manifest, "app/views/Missing.tsx")).toEqual([]);
  });
});
