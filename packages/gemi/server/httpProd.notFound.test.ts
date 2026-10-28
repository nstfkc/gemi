import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import { RecordNotFoundError } from "../orm/errors";

/**
 * #951: in production the `404` document shipped no CSS at all: `getStyles`
 * returned nothing when the request matched no route's views, dropping the
 * app stylesheet too. Against a real built-output directory and `Bun.serve`.
 */

class AppKernel extends Kernel {
  config = {
    route: {
      api: {
        rootRouter: class extends ApiRouter {
          routes = {};
        },
      },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {
          routes = {
            "/": this.view("Home", () => ({})),
            "/pages/:pageId": this.view("Home", () => {
              throw new RecordNotFoundError("Page", "findUniqueOrThrow");
            }),
          };
        },
      },
    },
  };
}

const APP_CSS = ".app-css{color:red}";
const NOT_FOUND_CSS = ".not-found-css{color:blue}";
const HOME_CSS = ".home-css{color:green}";

let projectDir: string;
let server: { port: number; stop: (force?: boolean) => unknown };
const savedEnv = { ...process.env };

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "gemi-prod-404-"));
  const dist = join(projectDir, "dist");
  await mkdir(join(dist, "client/.vite"), { recursive: true });
  await mkdir(join(dist, "client/assets"), { recursive: true });
  await mkdir(join(dist, "server/.vite"), { recursive: true });

  const app = new App({ kernel: AppKernel });
  const clientManifest: Record<string, { file: string; isEntry?: boolean; css?: string[] }> = {
    "app/client.tsx": { file: "assets/client.js", isEntry: true, css: ["assets/app.css"] },
  };
  // Every view `httpProd` looks up, the framework's own included: the mocked
  // module answers only the keys it has.
  for (const view of ["404", ...app.getFlatComponentTree()]) {
    clientManifest[`app/views/${view}.tsx`] = { file: `assets/${view.replaceAll("/", "-")}.js` };
  }
  clientManifest["app/views/404.tsx"].css = ["assets/404.css"];
  clientManifest["app/views/Home.tsx"].css = ["assets/Home.css"];
  await writeFile(join(dist, "client/.vite/manifest.json"), JSON.stringify(clientManifest));
  await writeFile(join(dist, "client/assets/client.js"), "");
  await writeFile(join(dist, "client/assets/404.js"), "");
  await writeFile(join(dist, "client/assets/Home.js"), "");
  await writeFile(join(dist, "client/assets/app.css"), APP_CSS);
  await writeFile(join(dist, "client/assets/404.css"), NOT_FOUND_CSS);
  await writeFile(join(dist, "client/assets/Home.css"), HOME_CSS);

  const serverManifest: Record<string, { file: string }> = {};
  for (const [i, view] of ["404", ...app.getFlatComponentTree()].entries()) {
    serverManifest[`app/views/${view}.tsx`] = { file: `view-${i}.js` };
    await writeFile(
      join(dist, `server/view-${i}.js`),
      "export default function View() { return null; }\n",
    );
  }
  await writeFile(join(dist, "server/.vite/manifest.json"), JSON.stringify(serverManifest));
  // `httpProd` reads the manifests the way Bun imports them.
  vi.doMock(join(dist, "server/.vite/manifest.json"), () => serverManifest);
  vi.doMock(join(dist, "client/.vite/manifest.json"), () => clientManifest);

  // `projectRoot()` joins this onto the cwd, so it has to be relative.
  process.env.GEMI_PROJECT_DIR = relative(process.cwd(), projectDir);
  process.env.PORT = "0";
  process.env.SECRET ??= "test-secret";
  process.env.GEMI_COMPRESSION = "off";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const { httpProd } = await import("./httpProd");
  server = (await httpProd(app, (req, next) => next(req))) as any;
});

afterAll(async () => {
  server?.stop(true);
  process.env = savedEnv;
  vi.restoreAllMocks();
  await rm(projectDir, { recursive: true, force: true });
});

async function document(path: string) {
  const res = await fetch(`http://localhost:${server.port}${path}`);
  return { status: res.status, body: await res.text() };
}

describe("httpProd: the 404 document's styles (#951)", () => {
  test("a matched view gets the app CSS and its own", async () => {
    const res = await document("/");
    expect(res.status).toBe(200);
    expect(res.body).toContain(APP_CSS);
    expect(res.body).toContain(HOME_CSS);
  });

  test.each([
    ["an unmatched path", "/does-not-exist"],
    ["a missing record", "/pages/someone-elses"],
  ])("%s gets the app CSS and the 404 view's", async (_, path) => {
    const res = await document(path);
    expect(res.status).toBe(404);
    expect(res.body).toContain("<style");
    expect(res.body).toContain(APP_CSS);
    expect(res.body).toContain(NOT_FOUND_CSS);
    expect(res.body).not.toContain(HOME_CSS);
  });
});

describe("httpProd: the build a page and its navigations came from (#1056)", () => {
  test("a `.json` navigation names the build the document carries", async () => {
    const { body } = await document("/");
    const buildId = body.match(/"buildId":"([^"]+)"/)?.[1];
    expect(buildId).toMatch(/^[\w-]{12}$/);

    const res = await fetch(`http://localhost:${server.port}/.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gemi-build")).toBe(buildId);
  });

  test("a document does not send the header", async () => {
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.headers.get("x-gemi-build")).toBeNull();
  });
});
