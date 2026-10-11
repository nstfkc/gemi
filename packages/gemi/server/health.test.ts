import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_HEALTH_PATH,
  healthSettings,
  liveness,
  recordLag,
  resetLiveness,
  serveHealth,
  startLivenessSampler,
} from "./health";
import { markShuttingDown, resetShuttingDown } from "./shutdown";

const limits = { maxLagMs: 100, breaches: 3 };

afterEach(() => {
  resetLiveness();
  resetShuttingDown();
  vi.restoreAllMocks();
});

describe("liveness", () => {
  test("is healthy with no samples", () => {
    expect(liveness()).toEqual({
      healthy: true,
      shuttingDown: false,
      lagMs: 0,
      consecutiveBreaches: 0,
    });
  });

  test("degrades only after the configured breaches in a row, and recovers at the first good sample", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    recordLag(500, limits);
    recordLag(500, limits);
    expect(liveness()).toMatchObject({ healthy: true, consecutiveBreaches: 2, lagMs: 500 });

    // One good sample in between starts the count over: a lone GC pause
    // never adds up to an eviction.
    recordLag(10, limits);
    recordLag(500, limits);
    recordLag(500, limits);
    expect(liveness().healthy).toBe(true);

    recordLag(500, limits);
    expect(liveness()).toMatchObject({ healthy: false, consecutiveBreaches: 3 });
    recordLag(800, limits);
    expect(liveness().healthy).toBe(false);

    recordLag(5, limits);
    expect(liveness()).toMatchObject({ healthy: true, consecutiveBreaches: 0, lagMs: 5 });

    // One line per flip, not per sample.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("degraded");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("recovered");
  });

  test("a sample exactly at the threshold is not a breach", () => {
    recordLag(100, limits);
    expect(liveness().consecutiveBreaches).toBe(0);
  });

  test("is unhealthy while shutting down, whatever the loop says", () => {
    markShuttingDown();
    expect(liveness()).toMatchObject({ healthy: false, shuttingDown: true });
  });
});

describe("startLivenessSampler", () => {
  test("measures a blocked event loop, and starts only once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const settings = { paths: [], intervalMs: 20, maxLagMs: 50, breaches: 1 };
    const setInterval = vi.spyOn(globalThis, "setInterval");
    startLivenessSampler(settings);
    startLivenessSampler(settings);
    expect(setInterval).toHaveBeenCalledTimes(1);

    const until = performance.now() + 150;
    while (performance.now() < until) {
      // Holds the loop, as a stalled process would.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The late tick flipped the verdict; the on-time ones after it may already
    // have flipped it back, which is the point of a verdict that is not latched.
    expect(warn).toHaveBeenCalledTimes(1);
    const lag = Number(/lag (\d+)ms/.exec(warn.mock.calls[0][0])?.[1]);
    expect(lag).toBeGreaterThan(50);
  });
});

describe("healthSettings", () => {
  test("defaults", () => {
    expect(healthSettings({})).toEqual({
      paths: [DEFAULT_HEALTH_PATH],
      intervalMs: 500,
      maxLagMs: 1000,
      breaches: 3,
    });
  });

  test("reads every variable", () => {
    expect(
      healthSettings({
        GEMI_HEALTH_PATH: " /health, /healthz ",
        GEMI_HEALTH_INTERVAL_MS: "250",
        GEMI_HEALTH_MAX_LAG_MS: "2000",
        GEMI_HEALTH_BREACHES: "5",
      }),
    ).toEqual({ paths: ["/health", "/healthz"], intervalMs: 250, maxLagMs: 2000, breaches: 5 });
  });

  test("off turns the route off", () => {
    expect(healthSettings({ GEMI_HEALTH_PATH: "OFF" }).paths).toEqual([]);
  });

  test("a path without a leading slash fails the boot", () => {
    expect(() => healthSettings({ GEMI_HEALTH_PATH: "health" })).toThrow(/GEMI_HEALTH_PATH/);
  });

  test("warns about a bad number and keeps the default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(healthSettings({ GEMI_HEALTH_BREACHES: "0" }).breaches).toBe(3);
    expect(healthSettings({ GEMI_HEALTH_MAX_LAG_MS: "soon" }).maxLagMs).toBe(1000);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("serveHealth", () => {
  const app = vi.fn(async () => new Response("app"));
  const instrumentation = vi.fn((req: Request, next: (req: Request) => Promise<Response>) =>
    next(req),
  );
  const serve = (paths = [DEFAULT_HEALTH_PATH]) => serveHealth(instrumentation, paths);
  const request = (path: string, method = "GET") =>
    new Request(`http://any-host.example${path}`, { method });

  afterEach(() => {
    app.mockClear();
    instrumentation.mockClear();
  });

  test("answers 200 ok, uncached, ahead of the app and its instrumentation", async () => {
    const res = await serve()(request(DEFAULT_HEALTH_PATH), app);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Connection")).toBeNull();
    expect(instrumentation).not.toHaveBeenCalled();
    expect(app).not.toHaveBeenCalled();
  });

  test("answers 503 with no numbers while degraded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) recordLag(4321, limits);
    const res = await serve()(request(DEFAULT_HEALTH_PATH), app);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe("degraded");
    expect(body).not.toMatch(/\d/);
  });

  test("answers 503 with Connection: close while shutting down", async () => {
    markShuttingDown();
    const res = await serve()(request(DEFAULT_HEALTH_PATH), app);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("shutting down");
    expect(res.headers.get("Connection")).toBe("close");
  });

  test("HEAD gets the status without a body; other methods get 405", async () => {
    const head = await serve()(request(DEFAULT_HEALTH_PATH, "HEAD"), app);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const post = await serve()(request(DEFAULT_HEALTH_PATH, "POST"), app);
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
    expect(app).not.toHaveBeenCalled();
  });

  test("answers on the configured paths only, the query string aside", async () => {
    const handler = serve(["/health", "/healthz"]);
    expect((await handler(request("/healthz?probe=1"), app)).status).toBe(200);
    expect(app).not.toHaveBeenCalled();

    expect(await (await handler(request(DEFAULT_HEALTH_PATH), app)).text()).toBe("app");
    expect(await (await handler(request("/health/deep"), app)).text()).toBe("app");
    expect(instrumentation).toHaveBeenCalledTimes(2);
  });

  test("with no paths, is the instrumentation itself", () => {
    expect(serveHealth(instrumentation, [])).toBe(instrumentation);
  });
});
