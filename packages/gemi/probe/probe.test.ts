import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  bundleProbes,
  probe,
  probeExpression,
  probeSource,
  PROBES_MANIFEST,
  resetProbes,
  type ProbePage,
} from "./index";

/**
 * Browser probes (#1020): `app/**\/*.probe.ts`, bundled into one IIFE and run
 * with `page.evaluate`.
 */

const savedProjectDir = process.env.GEMI_PROJECT_DIR;
const savedNodeEnv = process.env.NODE_ENV;
let projectDir: string;
let appDir: string;

const files: Record<string, string> = {
  "utils/geometry.ts": `
    export type Box = { w: number; h: number };
    export const area = (box: Box) => box.w * box.h;
  `,
  "utils/layout.probe.ts": `
    import { area, type Box } from "./geometry";
    export default function readLayout(boxes: Box[], label: string) {
      return { label, total: boxes.map(area).reduce((a, b) => a + b, 0), title: document.title };
    }
  `,
  "utils/async.probe.ts": `
    export default async function later(ms: number) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return document.querySelectorAll("p").length;
    }
  `,
  "utils/broken.probe.ts": `import missing from "./nowhere"; export default missing;`,
};

async function writeApp(path: string, source: string) {
  const file = join(appDir, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, source);
}

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "gemi-probe-"));
  appDir = join(projectDir, "app");
  for (const [path, source] of Object.entries(files)) await writeApp(path, source);
  // `projectRoot()` joins this onto the cwd, so it has to be relative.
  process.env.GEMI_PROJECT_DIR = relative(process.cwd(), projectDir);
});

afterAll(async () => {
  process.env.GEMI_PROJECT_DIR = savedProjectDir;
  if (savedProjectDir === undefined) delete process.env.GEMI_PROJECT_DIR;
  process.env.NODE_ENV = savedNodeEnv;
  await rm(projectDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.NODE_ENV = "test";
  resetProbes();
});

/** A page backed by jsdom: `evaluate` runs the expression in its window. */
function jsdomPage(html: string): ProbePage & { expressions: string[] } {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const expressions: string[] = [];
  return {
    expressions,
    async evaluate(expression: string) {
      expressions.push(expression);
      return await dom.window.eval(expression);
    },
  };
}

describe("bundling", () => {
  test("inlines the probe's imports into one IIFE", async () => {
    const source = await probeSource("utils/layout");
    expect(source.startsWith("(()=>{")).toBe(true);
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).toContain("__gemiProbe__(");
  });

  test("a probe that does not bundle throws with the bundler's message", async () => {
    await expect(probeSource("utils/broken")).rejects.toThrow(/does not bundle[\s\S]*nowhere/);
  });

  test("a missing probe names the file it looked for", async () => {
    await expect(probeSource("utils/none")).rejects.toThrow("app/utils/none.probe.ts");
  });

  test("a name must be a path under app/", () => {
    expect(() => probe("../etc/passwd")).toThrow(/path under app/);
    expect(() => probe("utils/layout.probe.ts")).toThrow(/path under app/);
  });

  test("bundleProbes bundles every probe that bundles, by name", async () => {
    await rm(join(appDir, "utils/broken.probe.ts"));
    try {
      const probes = await bundleProbes(appDir);
      expect(Object.keys(probes)).toEqual(["utils/async", "utils/layout"]);
    } finally {
      await writeApp("utils/broken.probe.ts", files["utils/broken.probe.ts"]!);
    }
  });
});

describe("the dev cache", () => {
  test("reuses the bundle until the probe or a file it imports changes", async () => {
    const first = await probeSource("utils/layout");
    expect(await probeSource("utils/layout")).toBe(first);

    await writeApp(
      "utils/geometry.ts",
      `export type Box = { w: number; h: number };
       export const area = (box: Box) => box.w * box.h * 1000;`,
    );
    // An mtime clearly apart from the first bundle's.
    const later = new Date(Date.now() + 5_000);
    await utimes(join(appDir, "utils/geometry.ts"), later, later);
    try {
      const second = await probeSource("utils/layout");
      expect(second).not.toBe(first);
      expect(second).toContain("*1000");
    } finally {
      await writeApp("utils/geometry.ts", files["utils/geometry.ts"]!);
    }
  });
});

describe("production", () => {
  test("reads gemi build's manifest and bundles nothing", async () => {
    await mkdir(join(projectDir, "dist", "server"), { recursive: true });
    const manifest = join(projectDir, "dist", "server", PROBES_MANIFEST);
    await writeFile(manifest, JSON.stringify({ "utils/layout": "__gemiProbe__(() => 'built')" }));
    process.env.NODE_ENV = "production";
    try {
      expect(await probeSource("utils/layout")).toBe("__gemiProbe__(() => 'built')");
      const page = jsdomPage("<p></p>");
      expect(await probe("utils/layout").run(page, [], "x")).toBe("built");
      // Not in the manifest: bundled from source, once.
      const fromSource = await probeSource("utils/async");
      expect(fromSource).toContain("__gemiProbe__(");
      expect(await probeSource("utils/async")).toBe(fromSource);
    } finally {
      await rm(join(projectDir, "dist"), { recursive: true, force: true });
    }
  });
});

describe("running", () => {
  test("hands the page one expression that calls the default export with the arguments", async () => {
    const readLayout = probe("utils/layout");
    const page = jsdomPage("<title>Home</title><p>hi</p>");
    const result = await readLayout.run(page, [{ w: 2, h: 3 }, { w: 1, h: 1 }], "sections");
    expect(result).toEqual({ label: "sections", total: 7, title: "Home" });
    expect(page.expressions).toHaveLength(1);
    expect(page.expressions[0]).toContain(`[[{"w":2,"h":3},{"w":1,"h":1}],"sections"]`);
  });

  test("an async probe's promise is what evaluate awaits", async () => {
    const page = jsdomPage("<p>a</p><p>b</p>");
    expect(await probe("utils/async").run(page, 1)).toBe(2);
  });

  test("expression() is the same text, for a driver that takes a script string", async () => {
    const readLayout = probe("utils/layout");
    const expression = await readLayout.expression([{ w: 1, h: 1 }], "x");
    expect(expression).toBe(probeExpression(await readLayout.source(), [[{ w: 1, h: 1 }], "x"]));
    const dom = new JSDOM("<title>T</title>", { runScripts: "outside-only" });
    expect(dom.window.eval(expression)).toEqual({ label: "x", total: 1, title: "T" });
  });

  test("leaves nothing behind in the page's scope", async () => {
    const dom = new JSDOM("", { runScripts: "outside-only" });
    dom.window.eval(await probe("utils/layout").expression([], "x"));
    expect("__gemiProbe__" in dom.window).toBe(false);
    expect("__gemiProbeFn__" in dom.window).toBe(false);
  });

  test("arguments must be JSON values", () => {
    expect(() => probeExpression("", undefined as never)).toThrow(/JSON/);
  });
});

/** A local Chrome or Chromium, when one is installed. */
function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null;
}

const chrome = findChrome();

/**
 * A real headless Chrome, driven over CDP with nothing but a WebSocket: a page
 * whose `evaluate` is `Runtime.evaluate`, as puppeteer's is.
 */
async function openChrome(executable: string) {
  const profile = await mkdtemp(join(tmpdir(), "gemi-probe-chrome-"));
  const child = Bun.spawn(
    [
      executable,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const close = async () => {
    child.kill();
    await child.exited;
    await rm(profile, { recursive: true, force: true });
  };
  try {
    const portFile = join(profile, "DevToolsActivePort");
    for (let tries = 0; tries < 100 && !existsSync(portFile); tries++) await Bun.sleep(100);
    const [port] = (await Bun.file(portFile).text()).split("\n");
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const target = targets.find((entry) => entry.type === "page")!;
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let id = 0;
    const pending = new Map<number, (message: any) => void>();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      pending.get(message.id)?.(message);
    };
    const send = (method: string, params: object) =>
      new Promise<any>((resolve) => {
        pending.set(++id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    const page: ProbePage = {
      async evaluate(expression) {
        const { result } = await send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      },
    };
    const setContent = (html: string) =>
      page.evaluate(`document.open(); document.write(${JSON.stringify(html)}); document.close();`);
    return {
      page,
      setContent,
      close: async () => {
        socket.close();
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe.skipIf(!chrome)("in a real headless Chrome", () => {
  test("runs a bundled probe with its imports, measuring real layout", async () => {
    await writeApp(
      "measure.probe.ts",
      `
      import { area } from "./utils/geometry";
      export default async function measure(selector: string) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { area: area({ w: rect.width, h: rect.height }), title: document.title };
      }
    `,
    );
    const browser = await openChrome(chrome!);
    try {
      await browser.setContent(
        `<title>Probe</title><div id="box" style="width:40px;height:25px"></div>`,
      );
      const measure = probe<(selector: string) => Promise<{ area: number; title: string }>>(
        "measure",
      );
      expect(await measure.run(browser.page, "#box")).toEqual({ area: 1000, title: "Probe" });
    } finally {
      await browser.close();
    }
  }, 30_000);
});
