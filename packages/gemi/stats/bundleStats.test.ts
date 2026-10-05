import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";

import {
  budgetFor,
  bundleStats,
  chunkName,
  markdownReport,
  overBudget,
  textReport,
  unusedBudgets,
  type BuildStats,
} from "./bundleStats";
import type { RouteTableEntry } from "./routeTable";

/**
 * A client build on disk: each file is `size` bytes of text that compresses
 * to almost nothing, so the raw sizes are exact and easy to add up.
 */
const dir = mkdtempSync(join(tmpdir(), "gemi-bundle-stats-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const files: Record<string, number> = {
  "assets/client-AAAAAAAA.js": 1000,
  "assets/react-BBBBBBBB.js": 4000,
  "assets/Home-CCCCCCCC.js": 300,
  "assets/AppLayout-DDDDDDDD.js": 200,
  "assets/Dashboard-EEEEEEEE.js": 500,
  "assets/Editor-FFFFFFFF.js": 9000,
  "assets/SitePage-GGGGGGGG.js": 100,
  "assets/SiteLayout-HHHHHHHH.js": 50,
  "assets/navMenu-IIIIIIII.js": 40,
  "assets/form-JJJJJJJJ.js": 60,
  "assets/dom-KKKKKKKK.js": 20,
  "assets/counter-LLLLLLLL.js": 30,
  "assets/Plain-MMMMMMMM.js": 10,
  "assets/_virtual_gemi-island-runtime-OOOOOOOO.js": 15,
  "assets/NavMenu-PPPPPPPP.js": 5,
  "assets/Form-QQQQQQQQ.js": 6,
  "assets/Counter-RRRRRRRR.js": 7,
  "assets/main-NNNNNNNN.css": 700,
};
for (const [file, size] of Object.entries(files)) {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, file), "a".repeat(size));
}
// A precompressed sibling is read instead of compressing the file again.
writeFileSync(join(dir, "assets/react-BBBBBBBB.js.gz"), Buffer.alloc(1234));
writeFileSync(join(dir, "assets/react-BBBBBBBB.js.br"), Buffer.alloc(999));

const manifest = {
  "app/client.tsx": {
    file: "assets/client-AAAAAAAA.js",
    isEntry: true,
    imports: ["_react.js", "app/views/RootLayout.tsx"],
    css: ["assets/main-NNNNNNNN.css"],
  },
  "_react.js": { file: "assets/react-BBBBBBBB.js" },
  // Bundled into the client entry; a static route without a layout renders in it.
  "app/views/RootLayout.tsx": { file: "assets/client-AAAAAAAA.js", imports: [] },
  "app/views/Home.tsx": { file: "assets/Home-CCCCCCCC.js", isEntry: true, imports: ["_react.js"] },
  "app/views/app/AppLayout.tsx": { file: "assets/AppLayout-DDDDDDDD.js", isEntry: true },
  "app/views/app/Dashboard.tsx": {
    file: "assets/Dashboard-EEEEEEEE.js",
    isEntry: true,
    imports: ["_react.js"],
    // Lazy: not part of the initial JS.
    dynamicImports: ["app/views/app/Editor.tsx"],
  },
  "app/views/app/Editor.tsx": { file: "assets/Editor-FFFFFFFF.js", isDynamicEntry: true },
  // A static view imports its islands' modules (`island()` imports them
  // statically); the manifest shows the chunks holding them, not the modules.
  "app/views/site/Page.tsx": {
    file: "assets/SitePage-GGGGGGGG.js",
    isEntry: true,
    imports: ["_react.js", "_form.js"],
    dynamicImports: ["app/views/site/Lazy.tsx"],
  },
  // Lazily imported: an island it can render still counts.
  "app/views/site/Lazy.tsx": { file: "assets/SitePage-GGGGGGGG.js", imports: ["_navMenu.js"] },
  "app/views/site/SiteLayout.tsx": {
    file: "assets/SiteLayout-HHHHHHHH.js",
    isEntry: true,
    imports: ["_navMenu.js"],
  },
  "_navMenu.js": { file: "assets/navMenu-IIIIIIII.js" },
  "_form.js": { file: "assets/form-JJJJJJJJ.js", imports: ["_react.js"] },
  "_counter.js": { file: "assets/counter-LLLLLLLL.js", imports: ["_react.js"] },
  // The island runtime: React and `react-dom/client`, shared by every island.
  "__virtual_gemi-island-runtime.js": {
    file: "assets/_virtual_gemi-island-runtime-OOOOOOOO.js",
    name: "_virtual_gemi-island-runtime",
    imports: ["_react.js", "_dom.js"],
  },
  "_dom.js": { file: "assets/dom-KKKKKKKK.js" },
  // Each island's entry: its module's chunk plus the runtime.
  "app/views/site/NavMenu.tsx?gemi-island": {
    file: "assets/NavMenu-PPPPPPPP.js",
    isEntry: true,
    imports: ["_navMenu.js", "__virtual_gemi-island-runtime.js"],
  },
  "app/views/site/Form.tsx?gemi-island": {
    file: "assets/Form-QQQQQQQQ.js",
    isEntry: true,
    imports: ["_form.js", "__virtual_gemi-island-runtime.js"],
  },
  // React imported directly too (a runtime Rollup merged into the entry): a
  // view that imports React doesn't render this island because of it.
  "app/views/widgets/Counter.tsx?gemi-island": {
    file: "assets/Counter-RRRRRRRR.js",
    isEntry: true,
    imports: ["_counter.js", "_react.js", "_dom.js"],
  },
  "app/views/Plain.tsx": { file: "assets/Plain-MMMMMMMM.js", isEntry: true, imports: ["_react.js"] },
};

const routes: RouteTableEntry[] = [
  { path: "/", group: "", views: ["Home"] },
  { path: "/app", group: "", views: ["app/AppLayout", "app/Dashboard"] },
  { path: "/p/:slug", group: "", views: ["site/Page"], static: { layout: "site/SiteLayout" } },
  { path: "/plain", group: "", views: ["Plain"], static: {} },
  { path: "/", group: "admin", views: ["Home"] },
];

const gz = (size: number) => gzipSync(Buffer.from("a".repeat(size)), { level: 9 }).length;
const raw = (...names: string[]) => names.reduce((total, name) => total + files[name]!, 0);

describe("bundleStats", () => {
  const stats = bundleStats({ clientDir: dir, manifest, routes });

  test("a hydrated route is the client entry plus its views' static imports", () => {
    expect(stats.by).toBe("routes");
    expect(stats.routes["/"]).toMatchObject({
      views: ["Home"],
      chunks: ["Home.js", "client.js", "react.js"],
      raw: raw("assets/client-AAAAAAAA.js", "assets/react-BBBBBBBB.js", "assets/Home-CCCCCCCC.js"),
    });
    expect(stats.routes["/"]!.static).toBeUndefined();
  });

  test("layouts count, lazy chunks don't", () => {
    expect(stats.routes["/app"]!.chunks).toEqual([
      "AppLayout.js",
      "Dashboard.js",
      "client.js",
      "react.js",
    ]);
  });

  test("a static route counts only the islands its views and layout can render", () => {
    const route = stats.routes["/p/:slug"]!;
    expect(route.static).toBe(true);
    expect(route.islands).toEqual([
      "app/views/site/Form.tsx?gemi-island",
      "app/views/site/NavMenu.tsx?gemi-island",
    ]);
    // No client entry, no view code; the runtime and React count once.
    expect(route.chunks).toEqual([
      "Form.js",
      "NavMenu.js",
      "_virtual_gemi-island-runtime.js",
      "dom.js",
      "form.js",
      "navMenu.js",
      "react.js",
    ]);
    expect(route.raw).toBe(
      raw(
        "assets/Form-QQQQQQQQ.js",
        "assets/NavMenu-PPPPPPPP.js",
        "assets/_virtual_gemi-island-runtime-OOOOOOOO.js",
        "assets/dom-KKKKKKKK.js",
        "assets/form-JJJJJJJJ.js",
        "assets/navMenu-IIIIIIII.js",
        "assets/react-BBBBBBBB.js",
      ),
    );
  });

  test("a static route without islands ships nothing, though its view imports React", () => {
    expect(stats.routes["/plain"]).toMatchObject({ raw: 0, gzip: 0, brotli: 0, chunks: [] });
  });

  test("other host groups are keyed by group", () => {
    expect(stats.routes["admin:/"]!.raw).toBe(stats.routes["/"]!.raw);
  });

  test("reads the precompressed siblings when they exist", () => {
    expect(stats.chunks["react.js"]).toEqual({ raw: 4000, gzip: 1234, brotli: 999 });
    expect(stats.chunks["Home.js"]!.gzip).toBe(gz(300));
  });

  test("lists every island with its imports, and the CSS", () => {
    expect(Object.keys(stats.islands)).toEqual([
      "app/views/site/Form.tsx?gemi-island",
      "app/views/site/NavMenu.tsx?gemi-island",
      "app/views/widgets/Counter.tsx?gemi-island",
    ]);
    expect(stats.islands["app/views/widgets/Counter.tsx?gemi-island"]!.chunks).toEqual([
      "Counter.js",
      "counter.js",
      "dom.js",
      "react.js",
    ]);
    expect(stats.css.raw).toBe(700);
  });

  test("without a route table, every view is a hydrated row", () => {
    const byView = bundleStats({ clientDir: dir, manifest });
    expect(byView.by).toBe("views");
    expect(Object.keys(byView.routes).sort()).toEqual([
      "Home",
      "Plain",
      "app/AppLayout",
      "app/Dashboard",
      "site/Page",
      "site/SiteLayout",
    ]);
    expect(byView.routes["site/Page"]!.chunks).toContain("client.js");
  });

  test("reads the manifest from the build when none is passed", () => {
    mkdirSync(join(dir, ".vite"), { recursive: true });
    writeFileSync(join(dir, ".vite/manifest.json"), JSON.stringify(manifest));
    expect(bundleStats({ clientDir: dir, routes }).routes["/"]!.raw).toBe(stats.routes["/"]!.raw);
  });
});

describe("chunkName", () => {
  test("drops the directory and the content hash", () => {
    expect(chunkName("assets/PageBuilder-C4f9a1Xz.js")).toBe("PageBuilder.js");
    expect(chunkName("assets/navMenu.island-a_b-1234.js")).toBe("navMenu.island.js");
    expect(chunkName("assets/_virtual_gemi-island-runtime-Dc8BWT3n.js")).toBe(
      "_virtual_gemi-island-runtime.js",
    );
  });
});

describe("budgets", () => {
  const stats = bundleStats({ clientDir: dir, manifest, routes });

  test("a route's own budget, then its page view's, then the default", () => {
    const budgets = { default: 10, routes: { "/": 1, "app/Dashboard": 2 } };
    expect(budgetFor("/", stats.routes["/"]!, budgets)).toBe(1);
    expect(budgetFor("/app", stats.routes["/app"]!, budgets)).toBe(2);
    expect(budgetFor("/plain", stats.routes["/plain"]!, budgets)).toBe(10);
    expect(budgetFor("/plain", stats.routes["/plain"]!, { routes: {} })).toBeUndefined();
  });

  test("reports the routes over their budget in the chosen unit", () => {
    expect(overBudget(stats, { unit: "raw", default: 100, routes: { "/plain": 0 } })).toEqual([]);
    expect(overBudget(stats, { unit: "raw", routes: { "/": 5, "/p/:slug": 5 } })).toEqual([
      "/: 5.2 KB raw is over its budget of 5 KB",
    ]);
    expect(overBudget(stats, undefined)).toEqual([]);
  });

  test("flags budget keys that match nothing", () => {
    expect(unusedBudgets(stats, { routes: { "/": 1, "site/Page": 1, Gone: 1 } })).toEqual([
      "Gone",
    ]);
  });
});

describe("reports", () => {
  const stats = bundleStats({ clientDir: dir, manifest, routes });

  test("the text table lists routes, kinds and budgets", () => {
    const text = textReport(stats, { unit: "raw", routes: { "/": 1 } });
    expect(text).toContain("Initial JavaScript per route:");
    expect(text).toMatch(/\/p\/:slug\s+static/);
    expect(text).toMatch(/^\/\s+hydrated.*1 OVER$/m);
    expect(text).toContain("app/views/site/NavMenu.tsx?gemi-island");
  });

  test("the Markdown compares with a base build", () => {
    const base: BuildStats = structuredClone(stats);
    base.routes["/app"]!.gzip -= 3 * 1024;
    delete base.routes["/plain"];
    base.routes["/gone"] = { ...base.routes["/"]!, views: ["Gone"] };
    delete base.chunks["dom.js"];
    base.chunks["old.js"] = { raw: 2048, gzip: 1024, brotli: 900 };

    const md = markdownReport(stats, base, { default: 1000 });
    expect(md).toContain("| `/app` ⚠️ |");
    expect(md).toMatch(/\| `\/plain` \(static\) \| 0\.0 \| new \|/);
    expect(md).toContain("**Removed routes:** `/gone`");
    expect(md).toContain("**New chunks:** `dom.js`");
    expect(md).toContain("**Removed chunks:** `old.js` (1.0 KB gzip)");
  });

  test("the Markdown marks a route over its budget", () => {
    expect(markdownReport(stats, null, { unit: "raw", routes: { "/": 1 } })).toContain(
      "| `/` ❌ |",
    );
  });
});
