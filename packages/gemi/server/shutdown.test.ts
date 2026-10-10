import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeConnectionWhileShuttingDown,
  drain,
  isShuttingDown,
  markShuttingDown,
  resetShuttingDown,
  serveForShutdown,
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

// The two requests the ordering test holds in flight at once. What it asserts
// is that `/slow` finishes before `/stream`'s last chunk, so the gap between
// the two — not either duration — is what a stalled worker has to eat through
// before the assertion inverts. 100ms against 6 × 80ms leaves ~380ms of it;
// the 300ms against 6 × 60ms it used to be left 60ms, which is well inside a
// scheduling hiccup when vitest runs several files in parallel.
const SLOW_MS = 100;
const CHUNK_MS = 80;

function serve() {
  // Paths the server has started handling, so a test waits for its requests
  // to be in flight rather than sleeping and hoping they got there: under a
  // loaded parallel run a fixed 30ms was sometimes not enough for `fetch` to
  // connect, and the drain then closed the listener in its face.
  const arrived: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      arrived.push(pathname);
      if (pathname === "/slow") {
        await Bun.sleep(SLOW_MS);
        events.push("slow finished");
        return new Response("slow");
      }
      if (pathname === "/stream") {
        let chunk = 0;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await Bun.sleep(CHUNK_MS);
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
  const inFlight = async (...paths: string[]) => {
    while (!paths.every((path) => arrived.includes(path))) await Bun.sleep(5);
  };
  return { url: `http://localhost:${server.port}`, stoppable, inFlight };
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
    const { url, stoppable, inFlight } = serve();
    const shutdownProviders = providers();

    const slow = fetch(`${url}/slow`).then((res) => res.text());
    const stream = fetch(`${url}/stream`).then((res) => res.text());
    await inFlight("/slow", "/stream");

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
    const { url, stoppable, inFlight } = serve();

    const slow = fetch(`${url}/slow`);
    await inFlight("/slow");
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
    const { url, stoppable, inFlight } = serve();
    const shutdownProviders = providers();

    void fetch(`${url}/forever`).catch(() => {});
    await inFlight("/forever");

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

  // A whole second of delay for a loopback round trip that takes a millisecond:
  // the assertion below is "the listener was still open", and it only means
  // that while the request beats the delay. At 200ms a CI worker that stalls
  // mid-fetch turns a real guarantee into a failed `fetch`, and the second
  // costs one slow test rather than a rerun.
  test("keeps serving through the delay, with the flag already up", async () => {
    const { url, stoppable } = serve();

    const draining = drain({
      server: stoppable,
      shutdownProviders: providers(),
      settings: settings({ delayMs: 1_000 }),
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

  // What `Server.stop()` passes when the signal beat the listener into
  // existence. That this is what a signal during the boot actually reaches —
  // that the handler is installed before the boot is awaited — is
  // `Server.test.ts`; here it is only that `drain` copes with no server.
  test("with no server — nothing was listening yet — still shuts providers down", async () => {
    const code = await drain({
      server: undefined,
      shutdownProviders: providers(),
      settings: settings(),
    });

    expect(events).toEqual(["providers"]);
    expect(code).toBe(0);
  });

  // `GEMI_SHUTDOWN_TIMEOUT=0` on a platform with a grace period too short to
  // spend on a drain. It means "do not wait", and a shutdown with nothing in
  // flight has nothing to abandon, so it is still a clean one.
  test("a zero timeout does not wait for the drain, and is not a failure by itself", async () => {
    const { stoppable } = serve();

    const code = await drain({
      server: stoppable,
      shutdownProviders: providers(),
      settings: settings({ timeoutMs: 0 }),
    });

    expect(events).toEqual(["stop() shuttingDown=true", "providers"]);
    expect(code).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  // Seen on a loaded Linux CI runner: with WebSockets in play, the graceful
  // stop's promise stayed pending after every request and socket was gone.
  test("with sockets to close, the drain ends once they are closed and no request is in flight, even if stop() never settles", async () => {
    const stoppable: Stoppable = { stop: () => new Promise<void>(() => {}), pendingRequests: 0 };
    let socketsClosedAt = 0;
    const started = Date.now();
    const code = await drain({
      server: stoppable,
      closeSockets: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            socketsClosedAt = Date.now();
            resolve();
          }, 100),
        ),
      shutdownProviders: providers(),
      settings: settings({ timeoutMs: 5_000 }),
    });
    expect(code).toBe(0);
    expect(socketsClosedAt).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(events).toEqual(["providers"]);
  });

  test("a zero timeout still reports a request it abandoned", async () => {
    const { url, stoppable, inFlight } = serve();

    void fetch(`${url}/forever`).catch(() => {});
    await inFlight("/forever");

    const code = await drain({
      server: stoppable,
      shutdownProviders: providers(),
      settings: settings({ timeoutMs: 0 }),
    });

    expect(events).toEqual([
      "stop() shuttingDown=true",
      "stop(force) shuttingDown=true",
      "providers",
    ]);
    expect(code).toBe(1);
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

/**
 * One TCP connection, kept alive, with requests written down it by hand —
 * `fetch` pools its own connections and may open a fresh one, which the closed
 * listener would refuse and the test would pass for the wrong reason.
 */
async function keptAliveConnection(port: number) {
  const socket = connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffer = "";
  socket.on("data", (chunk) => (buffer += chunk.toString()));
  return {
    // Resolves with the head and body of one response, read by its
    // `Content-Length`: enough for the short bodies these tests send.
    async get(path: string): Promise<{ head: string; body: string }> {
      buffer = "";
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        const length = end === -1 ? NaN : Number(/content-length: (\d+)/i.exec(buffer)?.[1]);
        if (buffer.length >= end + 4 + length) {
          return { head: buffer.slice(0, end), body: buffer.slice(end + 4, end + 4 + length) };
        }
        if (socket.destroyed) throw new Error(`connection closed after ${JSON.stringify(buffer)}`);
        await Bun.sleep(10);
      }
    },
    /** `get`, or `"closed"` when the server hangs up before answering. */
    async getOrClosed(path: string): Promise<{ head: string; body: string } | "closed"> {
      try {
        return await this.get(path);
      } catch (error) {
        if (socket.destroyed && buffer === "") return "closed";
        throw error;
      }
    },
    close: () => socket.destroy(),
  };
}

/**
 * Bun 1.4.0 started closing idle kept-alive connections in `server.stop()`;
 * 1.3 leaves them open (checked on 1.3.14, 1.4.0, 1.4.1 and 1.4.2, Linux and
 * macOS). On 1.4 a request down such a connection after the drain never
 * arrives, which is the same guarantee `serveForShutdown` gives on 1.3 — so the
 * tests below hold either way and say which one they saw.
 */
const BUN_CLOSES_IDLE_CONNECTIONS_ON_STOP = Bun.semver.satisfies(Bun.version, ">=1.4.0");

/** A request after the drain: refused with a 503 on Bun 1.3, hung up on by Bun 1.4. */
function expectRefused(response: { head: string; body: string } | "closed") {
  if (BUN_CLOSES_IDLE_CONNECTIONS_ON_STOP) {
    expect(response).toBe("closed");
    return;
  }
  expect(response).not.toBe("closed");
  const { head } = response as { head: string };
  expect(head).toMatch(/^HTTP\/1\.1 503/);
  expect(head).toMatch(/^connection: close$/im);
}

// Item 3 of #566. `server.stop()` closes the listener but not a kept-alive
// connection that is idle at the time, so a client that ignores the drain's
// `Connection: close` can still deliver a request while the providers shut
// down. Against a real `Bun.serve`, with a provider hook held open so the
// request lands squarely in that window.
describe("serveForShutdown", () => {
  function serveThroughShutdown() {
    const reached: string[] = [];
    const respond = serveForShutdown(async (req, next) => {
      reached.push(`instrumentation ${new URL(req.url).pathname}`);
      return next(req);
    });
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        respond(req, async (req) => {
          const path = new URL(req.url).pathname;
          reached.push(`app ${path}`);
          // Outlasts any drain budget, so the drain times out on it.
          if (path === "/slow") await new Promise(() => {});
          return new Response("ok");
        }),
    });
    servers.push(server);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const shutdownProviders = async () => {
      events.push("providers");
      await held;
      return { failed: [], timedOut: [] };
    };
    return { server, reached, shutdownProviders, release };
  }

  async function untilProvidersRun() {
    while (!events.includes("providers")) await Bun.sleep(10);
  }

  // The premise, pinned per Bun version so this file notices when it moves.
  // On 1.3 the refusal below is what stands between such a request and the
  // app; from 1.4.0 Bun closes the connection itself. Once gemi requires
  // Bun 1.4, `serveForShutdown` and the refusal tests can go.
  test("a kept-alive connection outlives the drain on Bun 1.3, and is closed by it on 1.4", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("served") });
    servers.push(server);
    const connection = await keptAliveConnection(server.port);
    await connection.get("/");

    await server.stop();
    const after = await connection.getOrClosed("/");

    if (BUN_CLOSES_IDLE_CONNECTIONS_ON_STOP) {
      expect(after).toBe("closed");
    } else {
      expect(after).not.toBe("closed");
      expect((after as { head: string }).head).toMatch(/^HTTP\/1\.1 200/);
      expect((after as { body: string }).body).toBe("served");
    }
    connection.close();
  });

  test("refuses a request down it once the drain is over, before the app or its instrumentation", async () => {
    const { server, reached, shutdownProviders, release } = serveThroughShutdown();
    const connection = await keptAliveConnection(server.port);
    expect((await connection.get("/before")).body).toBe("ok");

    const draining = drain({ server, shutdownProviders, settings: settings() });
    await untilProvidersRun();
    // Twice: Bun does not close the socket after a `Connection: close`
    // response, so a client that ignores it can keep sending.
    const refused = [
      await connection.getOrClosed("/after"),
      await connection.getOrClosed("/again"),
    ];
    release();

    for (const response of refused) expectRefused(response);
    expect(reached).toEqual(["instrumentation /before", "app /before"]);
    expect(await draining).toBe(0);
    connection.close();
  });

  // The flag is set on the timed-out path too: providers are shut down after a
  // drain that gave up, just as after one that finished.
  test("refuses a request down it after a drain that timed out, while the providers shut down", async () => {
    const { server, reached, shutdownProviders, release } = serveThroughShutdown();
    const idle = await keptAliveConnection(server.port);
    expect((await idle.get("/before")).body).toBe("ok");
    const busy = await keptAliveConnection(server.port);
    // Never answered: the abandoning `stop(true)` may cut it off.
    busy.get("/slow").catch(() => {});
    while (!reached.includes("app /slow")) await Bun.sleep(10);

    const draining = drain({ server, shutdownProviders, settings: settings({ timeoutMs: 100 }) });
    await untilProvidersRun();
    const refused = await idle.getOrClosed("/after");
    release();

    expectRefused(refused);
    expect(reached).not.toContain("instrumentation /after");
    expect(reached).not.toContain("app /after");
    // 1: the drain gave up on `/slow`.
    expect(await draining).toBe(1);
    idle.close();
    busy.close();
  });

  test("serves with Connection: close while the requests drain, and refuses nothing yet", async () => {
    const { server, reached, shutdownProviders, release } = serveThroughShutdown();
    const connection = await keptAliveConnection(server.port);
    release();

    markShuttingDown();
    const during = await connection.get("/during");
    await drain({ server, shutdownProviders, settings: settings() });

    expect(during.head).toMatch(/^HTTP\/1\.1 200/);
    expect(during.head).toMatch(/^connection: close$/im);
    expect(reached).toEqual(["instrumentation /during", "app /during"]);
    connection.close();
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
// script that installs it around a `stop` of its own, with both durations —
// how long the drain takes and how wide the repeat window is — chosen per test
// through the environment. Each test then asks for margins its own assertion
// can survive a stalled CI worker with, rather than every test sharing one set
// and the tightest of them deciding how often the suite lies.
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
        await Bun.sleep(Number(process.env.GEMI_TEST_STOP_MS));
        return 0;
      },
      { repeatWindowMs: Number(process.env.GEMI_TEST_REPEAT_WINDOW_MS) },
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

  // 400ms of drain: long enough that a process which waited for it and one
  // which did not are never confused, short enough to pay per test.
  const STOP_MS = 400;

  async function run(
    signals: NodeJS.Signals[],
    options: { gapMs?: number; stopMs?: number; repeatWindowMs?: number } = {},
  ) {
    const { gapMs = 50, stopMs = STOP_MS, repeatWindowMs = 150 } = options;
    const proc = Bun.spawn({
      cmd: ["bun", script],
      env: {
        ...process.env,
        GEMI_TEST_STOP_MS: String(stopMs),
        GEMI_TEST_REPEAT_WINDOW_MS: String(repeatWindowMs),
      },
      stdout: "pipe",
      stderr: "ignore",
    });
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
    expect(elapsed).toBeGreaterThanOrEqual(STOP_MS);
  });

  // One shutdown delivered more than once — directly and through a relay —
  // must still drain, whichever of the two signals each copy is. A two-second
  // window for copies sent 20ms apart: the production default is a second, and
  // the assertion is about the copies being one shutdown, not about where the
  // boundary sits, so the margin is free.
  test("a repeat inside the window is the same shutdown, not a force", async () => {
    const { code, elapsed, lines } = await run(["SIGTERM", "SIGTERM", "SIGINT"], {
      gapMs: 20,
      repeatWindowMs: 2_000,
    });

    expect(lines).toEqual(["ready", "stop 1"]);
    expect(code).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(STOP_MS);
  });

  // The other side of the boundary, with margins both ways: the second signal
  // is sent at 400ms against a 150ms window (a stall only pushes it further
  // out), and the drain it skips would take five seconds, so "exited at once"
  // is anything short of three.
  test("a second signal after the window exits at once with 128 + n", async () => {
    const { code, elapsed, lines } = await run(["SIGTERM", "SIGINT"], {
      gapMs: 400,
      stopMs: 5_000,
      repeatWindowMs: 150,
    });

    expect(lines).toEqual(["ready", "stop 1"]);
    expect(code).toBe(130);
    expect(elapsed).toBeLessThan(3_000);
  });
});
