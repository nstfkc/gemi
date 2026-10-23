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

/**
 * #1040: a view gemi's auth routes need, missing from the build, fails the
 * production boot with the file and the setting that requires it.
 */

const provider = {
  getRedirectUrl: async () => "https://idp.example/authorize",
  onCallback: async () => ({ providerId: "p1", email: "ada@example.com", emailVerified: true }),
};

class AppKernel extends Kernel {
  config = {
    auth: { magicLink: false, oauthProviders: { google: provider } },
    route: {
      api: {
        rootRouter: class extends ApiRouter {
          routes = {};
        },
      },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {
          routes = { "/": this.view("Home", () => ({})) };
        },
      },
    },
  };
}

let projectDir: string;
const savedEnv = { ...process.env };

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "gemi-prod-required-"));
  const dist = join(projectDir, "dist");
  await mkdir(join(dist, "client/.vite"), { recursive: true });
  await mkdir(join(dist, "server/.vite"), { recursive: true });

  const clientManifest: Record<string, { file: string; isEntry?: boolean }> = {
    "app/client.tsx": { file: "assets/client.js", isEntry: true },
  };
  // The app has its own views and `_Redirect`, but no `auth/OauthCallback`.
  const serverManifest: Record<string, { file: string }> = {};
  for (const [i, view] of ["404", "Home", "_Redirect"].entries()) {
    serverManifest[`app/views/${view}.tsx`] = { file: `view-${i}.js` };
    clientManifest[`app/views/${view}.tsx`] = { file: `assets/view-${i}.js` };
    await writeFile(join(dist, `server/view-${i}.js`), "export default function View() { return null; }\n");
  }
  await writeFile(join(dist, "server/.vite/manifest.json"), JSON.stringify(serverManifest));
  await writeFile(join(dist, "client/.vite/manifest.json"), JSON.stringify(clientManifest));
  // Listed as undefined: vitest's module mock throws on a key it was not given.
  vi.doMock(join(dist, "server/.vite/manifest.json"), () => ({
    ...serverManifest,
    "app/views/auth/OauthCallback.tsx": undefined,
  }));
  vi.doMock(join(dist, "client/.vite/manifest.json"), () => clientManifest);

  process.env.GEMI_PROJECT_DIR = relative(process.cwd(), projectDir);
  process.env.PORT = "0";
  process.env.SECRET ??= "test-secret";
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  process.env = savedEnv;
  vi.restoreAllMocks();
  await rm(projectDir, { recursive: true, force: true });
});

describe("httpProd and the views gemi's auth routes need (#1040)", () => {
  test("a missing one fails the boot, naming the file and the setting", async () => {
    const { httpProd } = await import("./httpProd");
    await expect(httpProd(new App({ kernel: AppKernel }), (req, next) => next(req))).rejects.toThrow(
      "app/views/auth/OauthCallback.tsx is missing. gemi's auth routes render it because auth.oauthProviders (google) is on.",
    );
  });
});
