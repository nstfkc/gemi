import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { RequestBreakerError } from "../http/Error";
import { Middleware } from "../http/Middleware";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";

/**
 * `httpProd` streams `dist/client` files before `app.fetch` is called, so no
 * route middleware ever sees `/assets/*` (#550). A global middleware runs in
 * front of that handler, against a real built-output directory and a real
 * `Bun.serve`.
 */

let ran = 0;

class NotThroughFrontDoor extends RequestBreakerError {
  constructor() {
    super("not through the front door");
    this.payload = {
      api: { status: 403, data: { error: "direct origin access" } },
      view: { status: 403, error: { message: "direct origin access" } },
    };
  }
}

class FrontDoor extends Middleware {
  run() {
    ran++;
    if (this.req.headers.get("x-azure-fdid") !== "fd-1") {
      throw new NotThroughFrontDoor();
    }
    this.req.ctx().setHeaders("X-Gate", "front-door");
    this.req.ctx().setCookie("visitor", "v-1");
  }
}

class AppKernel extends Kernel {
  config = {
    middleware: { aliases: { "front-door": FrontDoor }, global: ["front-door"] },
    route: {
      api: {
        rootRouter: class extends ApiRouter {
          routes = { "/ping": this.get(() => ({ ok: true })) };
        },
      },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
}

const ASSET = "console.log('app');\n";
const THROUGH_FRONT_DOOR = { "x-azure-fdid": "fd-1" };

// Build output Vite writes under `assets/` with an extension the old
// allowlist left out, and a root-level public font.
const FONT = "wOF2-font-bytes";
const GIF = "GIF89a-bytes";
const JSON_ASSET = '{"answer":42}';
const MANIFEST = '{"name":"app"}';
// Public files whose extensions no allowlist ever named (#583).
const VIDEO = "0123456789-mp4-bytes";
const WASM = "\0asm-bytes";
const CSV = "a,b\n1,2\n";

let seen: { forwardedFor: string | null; realIp: string | null } | null = null;
let projectDir: string;
let app: App;
let server: { port: number; stop: (force?: boolean) => unknown };
const savedEnv = { ...process.env };

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "gemi-global-mw-"));
  const dist = join(projectDir, "dist");
  await mkdir(join(dist, "client/.vite"), { recursive: true });
  await mkdir(join(dist, "client/assets"), { recursive: true });
  await mkdir(join(dist, "server/.vite"), { recursive: true });
  await writeFile(join(dist, "client/.vite/manifest.json"), "{}");
  await writeFile(join(dist, "client/assets/app.js"), ASSET);
  await writeFile(join(dist, "client/assets/font-abc123.woff2"), FONT);
  await writeFile(join(dist, "client/assets/spinner-abc123.gif"), GIF);
  await writeFile(join(dist, "client/assets/data-abc123.json"), JSON_ASSET);
  await mkdir(join(dist, "client/fonts"), { recursive: true });
  await writeFile(join(dist, "client/fonts/brand.woff2"), FONT);
  await writeFile(join(dist, "client/assets/my font-abc123.woff2"), FONT);
  await writeFile(join(dist, "client/manifest.json"), MANIFEST);
  await writeFile(join(dist, "client/loopVideo.mp4"), VIDEO);
  await writeFile(join(dist, "client/module.wasm"), WASM);
  await mkdir(join(dist, "client/v2/data"), { recursive: true });
  await writeFile(join(dist, "client/v2/data/report.csv"), CSV);
  await writeFile(join(dist, "client/notes.unknownext"), CSV);
  // Dotfiles copied in from `public/` are never served.
  await writeFile(join(dist, "client/.env"), "SECRET=1");
  await mkdir(join(dist, "client/.hidden"), { recursive: true });
  await writeFile(join(dist, "client/.hidden/file.txt"), "hidden");
  // Outside `dist/client`: what a traversal out of it would reach.
  await writeFile(join(dist, "secret.txt"), "secret");
  app = new App({ kernel: AppKernel });
  // A server chunk per view `httpProd` imports at startup: the 404 and the
  // views the framework mounts itself.
  const serverManifest: Record<string, { file: string }> = {};
  for (const [i, view] of ["404", ...app.getFlatComponentTree()].entries()) {
    serverManifest[`app/views/${view}.tsx`] = { file: `view-${i}.js` };
    await writeFile(
      join(dist, `server/view-${i}.js`),
      "export default function View() { return null; }\n",
    );
  }
  await writeFile(join(dist, "server/.vite/manifest.json"), JSON.stringify(serverManifest));
  // Vite's JSON import names only the keys that are identifiers, and Bun's
  // names them all; `httpProd` reads the manifest the way Bun imports it.
  vi.doMock(join(dist, "server/.vite/manifest.json"), () => serverManifest);

  // `projectRoot()` joins this onto the cwd, so it has to be relative.
  process.env.GEMI_PROJECT_DIR = relative(process.cwd(), projectDir);
  process.env.PORT = "0";
  process.env.SECRET ??= "test-secret";
  vi.spyOn(console, "log").mockImplementation(() => {});
  // The empty client manifest has no entry, which `httpProd` reports.
  vi.spyOn(console, "error").mockImplementation(() => {});

  const { httpProd } = await import("./httpProd");
  // No proxy is trusted, the default (#8).
  delete process.env.GEMI_TRUST_PROXY;
  server = (await httpProd(app, (req, next) => {
    seen = { forwardedFor: req.headers.get("x-forwarded-for"), realIp: req.headers.get("x-real-ip") };
    return next(req);
  })) as any;
});

afterAll(async () => {
  server?.stop(true);
  process.env = savedEnv;
  vi.restoreAllMocks();
  await rm(projectDir, { recursive: true, force: true });
});

beforeEach(() => {
  ran = 0;
});

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`http://localhost:${server.port}${path}`, { headers });
}

describe("httpProd with a global middleware", () => {
  test("refuses a built asset, before the static handler serves it", async () => {
    const res = await get("/assets/app.js");

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("direct origin access");
    expect(ran).toBe(1);
  });

  test("refuses the reload stub and the 404 a missing asset would get", async () => {
    expect((await get("/assets/gone.js")).status).toBe(403);
    expect((await get("/assets/gone.png")).status).toBe(403);
  });

  test("serves the asset once it passes, with the headers it set, and runs once", async () => {
    const res = await get("/assets/app.js", THROUGH_FRONT_DOOR);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ASSET);
    expect(res.headers.get("X-Gate")).toBe("front-door");
    expect(ran).toBe(1);
  });

  test("leaves the gate's cookie off an asset a shared cache may store", async () => {
    const res = await get("/assets/app.js", THROUGH_FRONT_DOOR);

    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    // The api response is not publicly cacheable, so it keeps the cookie.
    const api = await get("/api/ping", THROUGH_FRONT_DOOR);
    expect(api.headers.get("Set-Cookie")).toContain("visitor=v-1");
  });

  test("refuses an api route, and runs once for one that passes", async () => {
    const refused = await get("/api/ping");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "direct origin access" });

    ran = 0;
    const res = await get("/api/ping", THROUGH_FRONT_DOOR);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Gate")).toBe("front-door");
    expect(ran).toBe(1);
  });

  test("runs once for a file-shaped path the static handler hands to the app", async () => {
    // Not in dist/ and not under /assets, so it falls through to the router,
    // which renders the 404 view.
    const res = await get("/files/logo.svg", THROUGH_FRONT_DOOR);

    expect(res.status).toBe(404);
    expect(ran).toBe(1);
    // Not just the status: the gate's headers have to survive the whole way
    // out through a streamed document, which is a different path from the
    // asset above (a Response that already exists). Checked by dropping
    // `outcome.apply` in `App.fetch` — this assertion is what fails.
    expect(res.headers.get("X-Gate")).toBe("front-door");
  });
});

describe("httpProd's static handler", () => {
  const LONG_LIVED = "public, max-age=31536000, must-revalidate";

  // `httpProd` looks `app.fetch` up per request, so this spy sees every
  // request the static handler hands to the app. One spy cleared before
  // each test: with a spy created per test, a failing test's calls showed up
  // on the next test's spy, so one failure read as three.
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    fetchSpy = vi.spyOn(app, "fetch");
  });
  beforeEach(() => {
    fetchSpy.mockClear();
  });
  afterAll(() => {
    fetchSpy.mockRestore();
  });

  // The misses below are what hold `/assets` to being answered from
  // `dist/client` whatever its extension.
  test.each([
    ["/assets/font-abc123.woff2", FONT],
    ["/assets/spinner-abc123.gif", GIF],
    ["/assets/data-abc123.json", JSON_ASSET],
  ])("serves %s from dist/client, cached long-term", async (path, body) => {
    const res = await get(path, THROUGH_FRONT_DOOR);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.get("Cache-Control")).toBe(LONG_LIVED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("answers a missing file under /assets with a 404 of its own, whatever its extension", async () => {
    for (const path of ["/assets/gone-abc123.woff2", "/assets/gone.unknownext", "/assets/gone"]) {
      const res = await get(path, THROUGH_FRONT_DOOR);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("Not found");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("answers /assets itself with a 404, not the directory", async () => {
    // `dist/client/assets` exists, so an existence check alone would stream
    // a directory as a 200.

    for (const path of ["/assets", "/assets/"]) {
      const res = await get(path, THROUGH_FRONT_DOOR);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("Not found");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("still answers a missing chunk with the reload stub", async () => {
    const res = await get("/assets/gone-abc123.js", THROUGH_FRONT_DOOR);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("window.location.reload()");
  });

  test("serves a font outside /assets because the file exists", async () => {
    const res = await get("/fonts/brand.woff2", THROUGH_FRONT_DOOR);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FONT);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("serves a file whose name is percent-encoded in the URL", async () => {
    const res = await get("/assets/my%20font-abc123.woff2", THROUGH_FRONT_DOOR);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FONT);
  });

  test("never serves a file outside dist/client through an encoded separator", async () => {
    // `%2F` is not a separator to the URL parser, so its `..` normalization
    // leaves these alone; decoded, they climb out of `dist/client`.
    for (const path of [
      "/assets/..%2F..%2Fsecret.txt",
      "/..%2Fsecret.txt",
      "/assets/%E0%A4%A.txt",
    ]) {
      const res = await get(path, THROUGH_FRONT_DOOR);
      expect(await res.text(), path).not.toBe("secret");
    }
  });

  test("serves /manifest.json when the app ships one, and hands it to the app when not", async () => {
    const res = await get("/manifest.json", THROUGH_FRONT_DOOR);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MANIFEST);
    expect(fetchSpy).not.toHaveBeenCalled();

    const file = join(projectDir, "dist/client/manifest.json");
    await rename(file, file + ".away");
    try {
      await get("/manifest.json", THROUGH_FRONT_DOOR);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await rename(file + ".away", file);
    }
  });

  test("hands a missing file outside /assets, and view data, to the app", async () => {
    // A root-level extension may be an app route, and `.json` outside
    // /assets is how the client router fetches a view's data.
    await get("/fonts/gone.woff2", THROUGH_FRONT_DOOR);
    await get("/dashboard.json", THROUGH_FRONT_DOOR);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["/loopVideo.mp4", VIDEO, "video/mp4"],
    ["/module.wasm", WASM, "application/wasm"],
    ["/v2/data/report.csv", CSV, "text/csv"],
    ["/notes.unknownext", CSV, "application/octet-stream"],
  ])("serves public file %s whatever its extension (#583)", async (path, body, type) => {
    const res = await get(path, THROUGH_FRONT_DOOR);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.get("Content-Type")?.startsWith(type), path).toBe(true);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("answers a byte range of a public video with a 206", async () => {
    const res = await get("/loopVideo.mp4", { ...THROUGH_FRONT_DOOR, Range: "bytes=0-3" });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe(VIDEO.slice(0, 4));
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-3/${VIDEO.length}`);
    expect(res.headers.get("Content-Length")).toBe("4");

    // A window that does not start at 0, so a second slice on top of this
    // one (Bun's own range handling) would show.
    const middle = await get("/loopVideo.mp4", { ...THROUGH_FRONT_DOOR, Range: "bytes=4-7" });
    expect(middle.status).toBe(206);
    expect(await middle.text()).toBe(VIDEO.slice(4, 8));

    const suffix = await get("/loopVideo.mp4", { ...THROUGH_FRONT_DOOR, Range: "bytes=-5" });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe(VIDEO.slice(-5));
  });

  test("answers an unsatisfiable range with a 416", async () => {
    const res = await get("/loopVideo.mp4", { ...THROUGH_FRONT_DOOR, Range: "bytes=999-" });

    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${VIDEO.length}`);
  });

  test("never serves a dotfile, and hands a missing public path to the app", async () => {
    for (const [path, content] of [
      ["/.env", "SECRET=1"],
      ["/.hidden/file.txt", "hidden"],
      ["/.vite/manifest.json", "{}"],
      ["/gone.mp4", null],
    ]) {
      fetchSpy.mockClear();
      const res = await get(path!, THROUGH_FRONT_DOOR);
      expect(await res.text(), path!).not.toBe(content);
      expect(fetchSpy, path!).toHaveBeenCalledTimes(1);
    }
  });
});

describe("httpProd and X-Forwarded-For (#8)", () => {
  test("replaces a client-sent x-forwarded-for with the socket's address", async () => {
    await get("/api/ping", { ...THROUGH_FRONT_DOOR, "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" });

    expect(seen?.forwardedFor).not.toContain("6.6.6.6");
    expect(seen?.forwardedFor).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    expect(seen?.realIp).toBeNull();
  });

  test("sets it from the socket when the client sent none", async () => {
    await get("/api/ping", THROUGH_FRONT_DOOR);

    expect(seen?.forwardedFor).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
  });
});
