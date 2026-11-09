import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Query } from "../../facades/Prefetch";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { Layout, views } from "./__fixtures__/csp/page";

/**
 * `csp: true` in a real headless Chrome (#1195): a page served under the
 * strict policy (`script-src 'nonce-…' 'strict-dynamic'`) hydrates, streams a
 * query into a Suspense boundary and runs the app's own nonced script, with no
 * CSP violation. Driven over CDP with a bare WebSocket, as `probe.test.ts`
 * drives Chrome; skipped where no Chrome is installed.
 */

process.env.SECRET ??= "csp-chrome-test-secret";

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

class RootApiRouter extends ApiRouter {
  routes = {
    "/slow": this.get(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { rows: [1, 2, 3] };
    }),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => {
      (Query as any).prefetch("/slow");
      return {};
    }),
  };
}

class TestKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(Layout), rootRouter: RootViewRouter, csp: true },
    },
  };
}

async function bundleClient() {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dirname, "__fixtures__/csp/client.tsx")],
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    throw: false,
  });
  if (!result.success) {
    throw new Error(result.logs.map(String).join("\n"));
  }
  return await result.outputs[0].text();
}

/** A headless Chrome page over CDP. */
async function openChrome(executable: string) {
  const profile = await mkdtemp(join(tmpdir(), "gemi-csp-chrome-"));
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
    const socket = new WebSocket(targets.find((entry) => entry.type === "page")!.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let id = 0;
    const pending = new Map<number, (message: any) => void>();
    const events: { method: string; params: any }[] = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) pending.get(message.id)?.(message);
      else events.push(message);
    };
    const send = (method: string, params: object = {}) =>
      new Promise<any>((resolve) => {
        pending.set(++id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression: string) => {
      const { result } = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    return {
      send,
      evaluate,
      events,
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

describe.skipIf(!chrome)("the strict CSP in a real headless Chrome (#1195)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: Awaited<ReturnType<typeof openChrome>>;

  beforeAll(async () => {
    const client = await bundleClient();
    const app = new App({ kernel: TestKernel });
    const params = {
      getStyles: async () => [],
      viewImportMap: views,
      viewModules: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { default: v }])),
      loaders: "{}",
      cssManifest: {},
      ogMap: {},
      // Booted from the bootstrap script with `import()`, which only
      // `'strict-dynamic'` lets load.
      clientEntry: { module: "/assets/client.js", preload: ["/assets/client.js"] },
      modulePreloadManifest: {},
    };
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (new URL(req.url).pathname === "/assets/client.js") {
          return new Response(client, { headers: { "Content-Type": "text/javascript" } });
        }
        const answer = await app.fetch(req);
        return typeof answer === "function" ? await (answer as any)(params) : answer;
      },
    });
    browser = await openChrome(chrome!);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("a page hydrates, streams and runs nonced scripts with no violation", async () => {
    await browser.send("Runtime.enable");
    await browser.send("Log.enable");
    await browser.send("Page.enable");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__violations=[];document.addEventListener("securitypolicyviolation",function(e){window.__violations.push(e.violatedDirective+" "+e.blockedURI+" "+(e.sample||""))})`,
    });
    const url = `http://127.0.0.1:${server.port}/`;
    const res = await fetch(url);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/^script-src 'nonce-[^']+' 'strict-dynamic'/);
    await res.text();

    await browser.send("Page.navigate", { url });
    let state: any = null;
    for (let tries = 0; tries < 100; tries++) {
      state = await browser.evaluate(
        `({ hydrated: !!window.__hydrated, slow: document.getElementById("slow")?.textContent ?? null })`,
      ).catch(() => null);
      if (state?.hydrated && state.slow?.includes("rows")) break;
      await Bun.sleep(100);
    }
    expect(state).toEqual({ hydrated: true, slow: JSON.stringify({ rows: [1, 2, 3] }) });

    // Interactive: the click handler is React's, attached by hydration.
    await browser.evaluate(`document.getElementById("count").click()`);
    await Bun.sleep(50);
    const after = await browser.evaluate(`({
      count: document.getElementById("count").textContent,
      appScript: window.__appScript === true,
      gemiData: typeof window.__GEMI_DATA__,
      violations: window.__violations,
      hydrationErrors: window.__hydrationErrors ?? [],
    })`);
    expect(after).toEqual({
      count: "1",
      appScript: true,
      gemiData: "object",
      violations: [],
      hydrationErrors: [],
    });

    const consoleCsp = browser.events.filter(
      (event) =>
        (event.method === "Log.entryAdded" && /Content Security Policy/i.test(event.params.entry.text)) ||
        (event.method === "Runtime.consoleAPICalled" &&
          event.params.args.some((arg: any) => /Content Security Policy/i.test(String(arg.value)))),
    );
    expect(consoleCsp).toEqual([]);
  }, 30_000);
});
