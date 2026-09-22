import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeConnectionWhileShuttingDown,
  drain,
  isShuttingDown,
  markShuttingDown,
  resetShuttingDown,
  shutdownSettings,
  type ShutdownSettings,
  type Stoppable,
} from "./shutdown";

const settings = (overrides: Partial<ShutdownSettings> = {}): ShutdownSettings => ({
  timeoutMs: 5_000,
  delayMs: 0,
  providerTimeoutMs: 1_000,
  ...overrides,
});

// What happened, in order, across the server, its requests and the providers.
let events: string[];
let servers: Bun.Server<unknown>[];

beforeEach(() => {
  events = [];
  servers = [];
  resetShuttingDown();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const server of servers) server.stop(true);
  resetShuttingDown();
  vi.restoreAllMocks();
});

function serve() {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/slow") {
        await Bun.sleep(300);
        events.push("slow finished");
        return new Response("slow");
      }
      if (pathname === "/stream") {
        let chunk = 0;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await Bun.sleep(60);
              if (chunk++ < 5) return controller.enqueue(new TextEncoder().encode(`${chunk};`));
              events.push("stream finished");
              controller.close();
            },
          }),
        );
      }
      if (pathname === "/forever") {
        await new Promise(() => {});
      }
      return new Response("ok");
    },
  });
  servers.push(server);

  // The seam the ordering is asserted through: what the flag said at the
  // moment the listener was asked to close.
  const stoppable: Stoppable = {
    stop(force) {
      events.push(`stop(${force ? "force" : ""}) shuttingDown=${isShuttingDown()}`);
      return server.stop(force);
    },
    get pendingRequests() {
      return server.pendingRequests;
    },
  };
  return { url: `http://localhost:${server.port}`, stoppable };
}

const providers = (report = { failed: [] as string[], timedOut: [] as string[] }) =>
  vi.fn(async (_options: { timeoutMs: number }) => {
    events.push("providers");
    return report;
  });

describe("drain", () => {
  test("marks the process as shutting down before it stops accepting", async () => {
    const { stoppable } = serve();

    expect(isShuttingDown()).toBe(false);
    await drain({ server: stoppable, shutdownProviders: providers(), settings: settings() });

    expect(events[0]).toBe("stop() shuttingDown=true");
  });

  test("lets an in-flight request and a streamed response finish, then shuts providers down", async () => {
    const { url, stoppable } = serve();
    const shutdownProviders = providers();

    const slow = fetch(`${url}/slow`).then((res) => res.text());
    const stream = fetch(`${url}/stream`).then((res) => res.text());
    await Bun.sleep(30);

    const code = await drain({ server: stoppable, shutdownProviders, settings: settings() });

    expect(await slow).toBe("slow");
    expect(await stream).toBe("1;2;3;4;5;");
    expect(events).toEqual([
      "stop() shuttingDown=true",
      "slow finished",
      "stream finished",
      "providers",
    ]);
    expect(shutdownProviders).toHaveBeenCalledWith({ timeoutMs: 1_000 });
    expect(code).toBe(0);
  });

  test("refuses a new connection once the listener has closed", async () => {
    const { url, stoppable } = serve();

    const slow = fetch(`${url}/slow`);
    await Bun.sleep(30);
    const draining = drain({
      server: stoppable,
      shutdownProviders: providers(),
      settings: settings(),
    });

    // A fresh connection, not one from fetch's keep-alive pool.
    await expect(
      fetch(`${url}/`, { keepalive: false, headers: { Connection: "close" } }),
    ).rejects.toThrow();
    await slow;
    await draining;
  });

  test("gives up on requests still in flight when the grace period runs out", async () => {
    const { url, stoppable } = serve();
    const shutdownProviders = providers();

    void fetch(`${url}/forever`).catch(() => {});
    await Bun.sleep(30);

    const started = Date.now();
    const code = await drain({
      server: stoppable,
      shutdownProviders,
      settings: settings({ timeoutMs: 200 }),
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(events).toEqual([
      "stop() shuttingDown=true",
      "stop(force) shuttingDown=true",
      "providers",
    ]);
    expect(code).toBe(1);
  });

  test("keeps serving through the delay, with the flag already up", async () => {
    const { url, stoppable } = serve();

    const draining = drain({
      server: stoppable,
      shutdownProviders: providers(),
      settings: settings({ delayMs: 200 }),
    });

    expect(isShuttingDown()).toBe(true);
    expect(await (await fetch(`${url}/`)).text()).toBe("ok");
    expect(events).toEqual([]);

    await draining;
    expect(events).toEqual(["stop() shuttingDown=true", "providers"]);
  });

  test("the delay counts against the grace period rather than extending it", async () => {
    const { stoppable } = serve();

    const started = Date.now();
    await drain({
      server: stoppable,
      shutdownProviders: providers(),
      settings: settings({ delayMs: 5_000, timeoutMs: 150 }),
    });

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("exits non-zero when a provider failed or overran", async () => {
    const failed = await drain({
      server: undefined,
      shutdownProviders: providers({ failed: ["Mail"], timedOut: [] }),
      settings: settings(),
    });
    const timedOut = await drain({
      server: undefined,
      shutdownProviders: providers({ failed: [], timedOut: ["Queue"] }),
      settings: settings(),
    });

    expect([failed, timedOut]).toEqual([1, 1]);
  });

  test("with no server yet — a signal during boot — still shuts providers down", async () => {
    const code = await drain({
      server: undefined,
      shutdownProviders: providers(),
      settings: settings(),
    });

    expect(events).toEqual(["providers"]);
    expect(code).toBe(0);
  });
});

describe("closeConnectionWhileShuttingDown", () => {
  test("leaves a response alone until shutdown begins", () => {
    const res = new Response("ok");
    expect(closeConnectionWhileShuttingDown(res).headers.get("Connection")).toBeNull();
  });

  test("adds Connection: close while shutting down", () => {
    markShuttingDown();

    expect(closeConnectionWhileShuttingDown(new Response("ok")).headers.get("Connection")).toBe(
      "close",
    );
  });

  test("copies a response whose headers are immutable instead of throwing", async () => {
    markShuttingDown();
    const res = new Response("body", { status: 201 });
    vi.spyOn(res.headers, "set").mockImplementation(() => {
      throw new TypeError("immutable");
    });

    const closed = closeConnectionWhileShuttingDown(res);

    expect(closed).not.toBe(res);
    expect(closed.status).toBe(201);
    expect(closed.headers.get("Connection")).toBe("close");
    expect(await closed.text()).toBe("body");
  });
});

describe("shutdownSettings", () => {
  test("defaults to a 20s drain and 5s for providers, no delay", () => {
    expect(shutdownSettings({})).toEqual({
      timeoutMs: 20_000,
      delayMs: 0,
      providerTimeoutMs: 5_000,
    });
  });

  test("reads seconds from the environment", () => {
    expect(
      shutdownSettings({
        GEMI_SHUTDOWN_TIMEOUT: "50",
        GEMI_SHUTDOWN_DELAY: "2.5",
        GEMI_SHUTDOWN_PROVIDER_TIMEOUT: "0",
      }),
    ).toEqual({ timeoutMs: 50_000, delayMs: 2_500, providerTimeoutMs: 0 });
  });

  test("falls back to the default, with a warning, on a value that is not a number of seconds", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(shutdownSettings({ GEMI_SHUTDOWN_TIMEOUT: "30s", GEMI_SHUTDOWN_DELAY: "-1" })).toEqual({
      timeoutMs: 20_000,
      delayMs: 0,
      providerTimeoutMs: 5_000,
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // `drain` would sleep the whole timeout away and abandon every request.
  test("warns when the delay leaves no time to drain, and keeps both as set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(shutdownSettings({ GEMI_SHUTDOWN_DELAY: "30" })).toEqual({
      timeoutMs: 20_000,
      delayMs: 30_000,
      providerTimeoutMs: 5_000,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("GEMI_SHUTDOWN_DELAY");

    warn.mockClear();
    shutdownSettings({ GEMI_SHUTDOWN_DELAY: "5" });
    shutdownSettings({ GEMI_SHUTDOWN_TIMEOUT: "0" });
    expect(warn).not.toHaveBeenCalled();
  });
});

// The signal handling proper exits the process, so it runs in a child: a
// script that installs it around a `stop` taking 400ms and exiting 0, with the
// repeat window cut to 150ms so a deliberate second signal fits inside `stop`.
describe("installShutdownSignals", () => {
  const dir = mkdtempSync(join(tmpdir(), "gemi-shutdown-signals-"));
  const script = join(dir, "server.ts");
  writeFileSync(
    script,
    `
    import { installShutdownSignals } from ${JSON.stringify(join(import.meta.dirname, "shutdown.ts"))};
    let stops = 0;
    installShutdownSignals(
      async () => {
        console.log("stop " + ++stops);
        await Bun.sleep(400);
        return 0;
      },
      { repeatWindowMs: 150 },
    );
    // Twice, as a second Server in the same process would: still one listener.
    installShutdownSignals(async () => {
      console.log("second listener ran");
      return 5;
    });
    console.log("ready");
    setInterval(() => {}, 1000);
  `,
  );

  async function run(signals: NodeJS.Signals[], gapMs = 50) {
    const proc = Bun.spawn({ cmd: ["bun", script], stdout: "pipe", stderr: "ignore" });
    const decoder = new TextDecoder();
    let output = "";
    const read = (async () => {
      for await (const chunk of proc.stdout) output += decoder.decode(chunk);
    })();
    while (!output.includes("ready")) await Bun.sleep(20);

    const started = Date.now();
    for (const [i, signal] of signals.entries()) {
      if (i > 0) await Bun.sleep(gapMs);
      proc.kill(signal);
    }
    const code = await proc.exited;
    await read;
    return {
      code,
      elapsed: Date.now() - started,
      lines: output
        .trim()
        .split("\n")
        .filter((line) => !line.startsWith("[gemi]")),
    };
  }

  test("the first signal drains and exits with stop()'s code", async () => {
    const { code, elapsed, lines } = await run(["SIGTERM"]);

    expect(lines).toEqual(["ready", "stop 1"]);
    expect(code).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  // One shutdown delivered more than once — directly and through a relay —
  // must still drain, whichever of the two signals each copy is.
  test("a repeat inside the window is the same shutdown, not a force", async () => {
    const { code, elapsed, lines } = await run(["SIGTERM", "SIGTERM", "SIGINT"], 20);

    expect(lines).toEqual(["ready", "stop 1"]);
    expect(code).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  test("a second signal after the window exits at once with 128 + n", async () => {
    const { code, elapsed, lines } = await run(["SIGTERM", "SIGINT"], 200);

    expect(lines).toEqual(["ready", "stop 1"]);
    expect(code).toBe(130);
    expect(elapsed).toBeLessThan(400);
  });
});
