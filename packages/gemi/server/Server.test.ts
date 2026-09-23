import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "../app";
import { Application } from "../foundation/Application";
import { app } from "../foundation/app";
import { Kernel } from "../kernel";
import { Repository } from "../support/Repository";
import { ServiceProvider } from "../support/ServiceProvider";
import { Server } from "./Server";
import { resetShuttingDown } from "./shutdown";

// `start()` needs a built `dist/` (production) or Vite (development), so this
// covers what `stop()` owns without it: that it reaches the application's
// providers, inside the application context, and only once. The drain itself
// is `shutdown.test.ts`.
const calls: string[] = [];

class First extends ServiceProvider {
  shutdown() {
    calls.push("First");
  }
}

class Second extends ServiceProvider {
  async shutdown() {
    // A hook reaches the container the way a request or a cron tick does.
    calls.push(`Second sees config: ${app(Repository) === this.app.config}`);
  }
}

class TestKernel extends Kernel {
  protected providers = [First, Second];
}

afterEach(() => {
  calls.length = 0;
  resetShuttingDown();
  Application.setInstance(undefined);
  vi.restoreAllMocks();
});

describe("Server.stop", () => {
  test("shuts the app's providers down in reverse order, in the application context, once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = new Server({ kernel: TestKernel, handleSignals: false });
    // `app()` falls back to the last-booted Application outside a context;
    // clear it, so only the kernel's own context can answer.
    Application.setInstance(undefined);

    const [first, second] = await Promise.all([server.stop(), server.stop()]);

    expect(calls).toEqual(["Second sees config: true", "First"]);
    expect([first, second]).toEqual([0, 0]);
  });
});

// `httpProd` reads a built `dist/`, so it is replaced by one that keeps the
// instrumentation `Server` hands it: that composed function is what wraps every
// production response, and the part of `start()` this file can reach.
const listening = { stop: async () => {}, pendingRequests: 0 };
const httpProd = vi.hoisted(() => ({
  instrumentation: undefined as
    | undefined
    | ((req: Request, next: (req: Request) => Promise<Response>) => Promise<Response>),
}));
vi.mock("./httpProd", () => ({
  httpProd: async (_app: unknown, instrumentation: typeof httpProd.instrumentation) => {
    httpProd.instrumentation = instrumentation;
    return listening;
  },
}));

describe("Server.start", () => {
  test("resolves with the server, whose responses close the connection once shutting down", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    // `start()` sets it; stubbed so the unstub below puts back what was there.
    vi.stubEnv("ROOT_DIR", process.env.ROOT_DIR);
    // A real boot needs an app's route config; this is about what follows it.
    vi.spyOn(App.prototype, "waitForBoot").mockResolvedValue(undefined);
    try {
      const server = new Server({
        kernel: TestKernel,
        handleSignals: false,
        // An app's own instrumentation, which the wrapper must sit outside of.
        instrumentation: async (req, next) => {
          const res = await next(req);
          res.headers.set("X-Instrumented", "yes");
          return res;
        },
      });

      expect(await server.start()).toBe(listening);

      const respond = () =>
        httpProd.instrumentation!(new Request("http://app/"), async () => new Response("ok"));
      const before = await respond();
      expect(before.headers.get("Connection")).toBeNull();
      expect(before.headers.get("X-Instrumented")).toBe("yes");

      await server.stop();
      const during = await respond();
      expect(during.headers.get("Connection")).toBe("close");
      expect(during.headers.get("X-Instrumented")).toBe("yes");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// The signal handling exits the process, so this runs in a child: a production
// `Server` whose boot never finishes — the pod whose connection pool is still
// connecting — signalled while it is still in there. What it proves is the
// ordering inside `start()`: the handler has to be installed *before* the
// boot is awaited, or the signal hits the default action and kills the process
// with nothing shut down. Nothing is stubbed but `waitForBoot`, which stands in
// for a boot slow enough to be signalled mid-way.
describe("a signal during the boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "gemi-boot-signal-"));
  const script = join(dir, "server.ts");
  const from = (...parts: string[]) => JSON.stringify(join(import.meta.dirname, "..", ...parts));
  writeFileSync(
    script,
    `
    import { App } from ${from("app", "index.ts")};
    import { Kernel } from ${from("kernel", "index.ts")};
    import { ServiceProvider } from ${from("support", "ServiceProvider.ts")};
    import { Server } from ${from("server", "Server.ts")};

    class Pool extends ServiceProvider {
      shutdown() {
        console.log("pool closed");
      }
    }
    class TestKernel extends Kernel {
      protected providers = [Pool];
    }

    // The boot that is still going when the signal lands.
    App.prototype.waitForBoot = () => new Promise(() => {});
    void new Server({ kernel: TestKernel }).start();
    console.log("booting");
    setInterval(() => {}, 1000);
  `,
  );

  test("drains the providers and exits with the drain's code, though nothing is listening yet", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", script],
      env: { ...process.env, NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const decoder = new TextDecoder();
    let output = "";
    const read = (async () => {
      for await (const chunk of proc.stdout) output += decoder.decode(chunk);
    })();
    while (!output.includes("booting")) await Bun.sleep(20);

    proc.kill("SIGTERM");
    const code = await proc.exited;
    await read;

    // Without the handler the default action ends the process at 128 + 15.
    expect(code).toBe(0);
    expect(output).toContain("pool closed");
  }, 20_000);
});
