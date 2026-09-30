import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../app";
import { Application } from "../foundation/Application";
import { Kernel } from "../kernel";
import { ServiceProvider } from "../support/ServiceProvider";
import { resetDevGeneration } from "./devReload";
import { Server } from "./Server";

/**
 * What `gemi dev` does on a `bun --hot` reload (#652): the reload runs the app's
 * `server.ts` again, which starts a new `Server` in the same process, and the
 * application that one replaces has to be shut down — its database pool, its
 * scheduler and its queue with it — once the new one is serving.
 *
 * `httpDev` needs Vite, so it is replaced by one that keeps the instrumentation
 * it is handed: that is how a request reaches an application in development,
 * and so what the in-flight count is taken through.
 */
const dev = vi.hoisted(() => ({
  served: [] as Array<
    (req: Request, next: (req: Request) => Promise<Response>) => Promise<Response>
  >,
}));
vi.mock("./httpDev", () => ({
  httpDev: async (_app: unknown, instrumentation: (typeof dev.served)[number]) => {
    dev.served.push(instrumentation);
    return { port: 0 };
  },
}));
vi.mock("./watchEnv", () => ({ watchEnv: () => {} }));

const events: string[] = [];

/** A kernel whose one provider says which generation it belongs to. */
function kernelFor(name: string) {
  class Pool extends ServiceProvider {
    shutdown() {
      events.push(`${name} shut down`);
    }
  }
  return class extends Kernel {
    protected providers = [Pool];
  };
}

beforeEach(() => {
  events.length = 0;
  dev.served.length = 0;
  resetDevGeneration();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("ROOT_DIR", process.env.ROOT_DIR);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  resetDevGeneration();
  Application.setInstance(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(10);
}

describe("a gemi dev reload", () => {
  test("shuts the application it replaced down, once the new one is serving", async () => {
    vi.spyOn(App.prototype, "waitForBoot").mockResolvedValue(undefined);

    await new Server({ kernel: kernelFor("first") }).start();
    expect(events).toEqual([]);

    await new Server({ kernel: kernelFor("second") }).start();
    await until(() => events.length > 0);
    expect(events).toEqual(["first shut down"]);

    await new Server({ kernel: kernelFor("third") }).start();
    await until(() => events.length > 1);
    expect(events).toEqual(["first shut down", "second shut down"]);
  });

  test("lets a request still on the replaced application finish first", async () => {
    vi.spyOn(App.prototype, "waitForBoot").mockResolvedValue(undefined);
    await new Server({ kernel: kernelFor("first") }).start();

    let release!: () => void;
    const response = dev.served[0](new Request("http://app/"), async () => {
      await new Promise<void>((resolve) => (release = resolve));
      events.push("request finished");
      return new Response("ok");
    });

    await new Server({ kernel: kernelFor("second") }).start();
    await Bun.sleep(50);
    expect(events).toEqual([]);

    release();
    expect(await (await response).text()).toBe("ok");
    await until(() => events.length > 1);
    expect(events).toEqual(["request finished", "first shut down"]);
  });

  test("a boot that throws shuts its own application down and leaves the serving one alone", async () => {
    const boot = vi.spyOn(App.prototype, "waitForBoot").mockResolvedValue(undefined);
    await new Server({ kernel: kernelFor("first") }).start();

    boot.mockRejectedValueOnce(new Error("syntax error in a provider"));
    await expect(new Server({ kernel: kernelFor("broken") }).start()).rejects.toThrow(
      "syntax error in a provider",
    );
    await until(() => events.length > 0);
    await Bun.sleep(20);
    expect(events).toEqual(["broken shut down"]);

    // The next good save replaces the application that was still serving.
    await new Server({ kernel: kernelFor("fixed") }).start();
    await until(() => events.length > 1);
    expect(events).toEqual(["broken shut down", "first shut down"]);
  });
});
