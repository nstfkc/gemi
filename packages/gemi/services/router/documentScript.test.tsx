import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import {
  bundleDocumentScripts,
  cspHashOf,
  documentScriptCspHash,
  documentScriptSource,
  resetDocumentScripts,
} from "./documentScript";

/**
 * `.static({ script })` (#919): a document script, bundled from
 * `app/views/<name>.script.ts` and inlined once in the head. How it behaves
 * across navigation swaps is in `staticNavigation.browser.test.tsx`.
 */

process.env.SECRET ??= "document-script-test-secret";

const Layout = (props: { children: ReactNode }) => (
  <html lang="en">
    <Head />
    <body>{props.children}</body>
  </html>
);

const views: Record<string, any> = {
  "404": () => <p>not found</p>,
  "site/Layout": Layout,
  "site/Page": () => (
    <main>
      <a href="https://elsewhere.dev">out</a>
    </main>
  ),
};

class TestViewRouter extends ViewRouter {
  routes = {
    "/plain": this.view("site/Page").static({ layout: "site/Layout", script: "site/clicks" }),
    "/nav": this.view("site/Page").static({
      layout: "site/Layout",
      navigation: { version: () => "v|1" },
      script: "site/clicks",
    }),
    "/nav-none": this.view("site/Page").static({ layout: "site/Layout", navigation: true }),
    "/per-request": this.view("site/Page", (req) => {
      req.ctx().setHeaders("x-analytics", new URL(req.rawRequest.url).searchParams.get("on") ?? "");
      return {};
    }).static({
      layout: "site/Layout",
      script: async (req) => (req.ctx().headers.get("x-analytics") === "1" ? "site/clicks" : null),
    }),
    "/missing": this.view("site/Page").static({ layout: "site/Layout", script: "site/nope" }),
  };
}

class TestKernel extends Kernel {
  config = {
    route: {
      api: {
        rootRouter: class extends ApiRouter {
          routes = {};
        },
      },
      view: { root: createRoot(Layout), rootRouter: TestViewRouter },
    },
  };
}

const params = {
  getStyles: async () => [],
  viewImportMap: views,
  viewModules: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { default: v }])),
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
  clientEntry: { module: "/assets/client.js", preload: ["/assets/client.js"] },
  buildId: "build-1",
};

let projectDir: string;
let app: App;
const savedProjectDir = process.env.GEMI_PROJECT_DIR;

const CLICKS = `import { send } from "./beacon";
const selector: string = "a[href]";
document.addEventListener("click", (event) => {
  const a = (event.target as Element).closest(selector);
  if (a) send((a as HTMLAnchorElement).href);
}, { capture: true });
`;
const BEACON = `export const send = (href: string) => navigator.sendBeacon("/api/l", href);
export const unused = () => "tree-shaken";
`;

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "gemi-document-script-"));
  await mkdir(join(projectDir, "app/views/site"), { recursive: true });
  await writeFile(join(projectDir, "app/views/site/clicks.script.ts"), CLICKS);
  await writeFile(join(projectDir, "app/views/site/beacon.ts"), BEACON);
  await writeFile(join(projectDir, "app/views/plain.script.js"), "console.log('plain');\n");
  // `projectRoot()` joins this onto the cwd, so it has to be relative.
  process.env.GEMI_PROJECT_DIR = relative(process.cwd(), projectDir);
  app = new App({ kernel: TestKernel });
});

afterAll(async () => {
  process.env.GEMI_PROJECT_DIR = savedProjectDir;
  if (savedProjectDir === undefined) delete process.env.GEMI_PROJECT_DIR;
  await rm(projectDir, { recursive: true, force: true });
});

beforeEach(() => resetDocumentScripts());

async function fetchPage(path: string) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(typeof render).toBe("function");
  return (await (render as any)(params)) as Response;
}

const head = (html: string) => html.match(/<head>(.*?)<\/head>/s)![1]!;
const inlined = (html: string) =>
  [...html.matchAll(/<script type="module" data-gemi-script="([^"]*)">(.*?)<\/script>/gs)].map(
    (m) => ({ name: m[1], source: m[2] }),
  );

describe(".static({ script })", () => {
  test("inlines the bundled, minified script once, at the end of the head", async () => {
    const html = await (await fetchPage("/plain")).text();
    const scripts = inlined(html);

    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.name).toBe("site/clicks");
    expect(head(html).endsWith(`</script>`)).toBe(true);
    // Bundled: the import is inlined, the types are gone, the unused export is not there.
    const source = scripts[0]!.source;
    expect(source).toContain("sendBeacon");
    expect(source).not.toContain("import");
    expect(source).not.toContain(": string");
    expect(source).not.toContain("tree-shaken");
    expect(source.startsWith("(()=>{")).toBe(true);
    // Without navigation or islands there is nothing else.
    expect(html).not.toContain("gemi-static");
  });

  test("its CSP hash is the hash of exactly the inlined text", async () => {
    const html = await (await fetchPage("/plain")).text();
    const source = inlined(html)[0]!.source;

    expect(await documentScriptCspHash("site/clicks")).toBe(cspHashOf(source));
    expect(source).toBe(await documentScriptSource("site/clicks"));
  });

  test("with navigation, the name is part of the identity, before the version", async () => {
    const html = await (await fetchPage("/nav")).text();

    expect(head(html)).toContain('<meta name="gemi-static" content="site/Layout|build-1|site/clicks|v|1"/>');
    expect(inlined(html)).toHaveLength(1);
    // The runtime stays at the end of the body, the script in the head.
    expect(html.indexOf("data-gemi-script")).toBeLessThan(html.indexOf("</head>"));
  });

  test("a page without one has an empty slot, so the two never swap into each other", async () => {
    const html = await (await fetchPage("/nav-none")).text();

    expect(head(html)).toContain('<meta name="gemi-static" content="site/Layout|build-1||"/>');
    expect(inlined(html)).toEqual([]);
  });

  test("a function picks it per request, after the handler", async () => {
    expect(inlined(await (await fetchPage("/per-request?on=1")).text())).toHaveLength(1);
    expect(inlined(await (await fetchPage("/per-request?on=0")).text())).toEqual([]);
  });

  test("a name with no file fails the render and says where the file goes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetchPage("/missing").catch((e: Error) => e);
    const message = res instanceof Error ? res.message : await res.text();
    expect(message).toMatch(/app\/views\/site\/nope\.script\.ts/);
    error.mockRestore();
  });
});

describe("documentScriptSource", () => {
  test("refuses a name that is not a path under app/views", async () => {
    await expect(documentScriptSource("../secrets")).rejects.toThrow(/path under app\/views/);
    await expect(documentScriptSource("site/clicks.script.ts")).rejects.toThrow(/path under app\/views/);
  });

  test("in production, reads what gemi build wrote rather than bundling", async () => {
    const dist = join(projectDir, "dist/server");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "document-scripts.json"), JSON.stringify({ "site/clicks": "built();" }));
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(await documentScriptSource("site/clicks")).toBe("built();");
      // Missing from the manifest: bundled from source, once.
      expect(await documentScriptSource("plain")).toContain("plain");
    } finally {
      process.env.NODE_ENV = env;
      await rm(join(projectDir, "dist"), { recursive: true, force: true });
    }
  });
});

describe("bundleDocumentScripts (gemi build)", () => {
  test("bundles every *.script.{ts,js} under app/views, by name", async () => {
    const scripts = await bundleDocumentScripts(join(projectDir, "app"));
    expect(Object.keys(scripts).sort()).toEqual(["plain", "site/clicks"]);
    expect(scripts["site/clicks"]).toBe(await documentScriptSource("site/clicks"));
  });

  test("refuses a script whose output would end the inline <script>", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gemi-document-script-bad-"));
    try {
      await mkdir(join(dir, "views"), { recursive: true });
      await writeFile(join(dir, "views/bad.script.ts"), 'console.log("</script>");\n');
      await expect(bundleDocumentScripts(dir)).rejects.toThrow(/<\/script/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
