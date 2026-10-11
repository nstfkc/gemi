import { closeConnectionWhileShuttingDown, isShuttingDown } from "./shutdown";
import type { Instrumentation } from "./types";

/**
 * What `liveness()` reports. `healthy` is the verdict the built-in health
 * route answers with; the numbers are for the app's own logs and metrics —
 * the route never puts them in a response (#48).
 */
export type Liveness = {
  /** Not shutting down, and fewer than `breaches` slow samples in a row. */
  healthy: boolean;
  /** Same as `isShuttingDown()`. */
  shuttingDown: boolean;
  /** How late the last sample fired, in milliseconds. 0 before the first. */
  lagMs: number;
  /** Samples in a row over `maxLagMs`, up to now. */
  consecutiveBreaches: number;
};

export type HealthSettings = {
  /**
   * The paths the built-in route answers on; empty turns it off.
   * `GEMI_HEALTH_PATH`, comma-separated, or `off`; default `/__gemi__/health`.
   */
  paths: string[];
  /** `GEMI_HEALTH_INTERVAL_MS`; default 500. */
  intervalMs: number;
  /** A sample later than this is a breach. `GEMI_HEALTH_MAX_LAG_MS`; default 1000. */
  maxLagMs: number;
  /** Breaches in a row before degraded. `GEMI_HEALTH_BREACHES`; default 3. */
  breaches: number;
};

export const DEFAULT_HEALTH_PATH = "/__gemi__/health";

// On `globalThis` under a registry symbol for the same reason as the shutdown
// flag: two copies of this module (the CLI's bundled gemi, a `bun --hot`
// reload) must read one sampler, and start one.
const STATE = Symbol.for("gemi.server.health");

type HealthState = {
  lagMs: number;
  consecutiveBreaches: number;
  degraded: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
};

function state(): HealthState {
  const global = globalThis as { [STATE]?: HealthState };
  global[STATE] ??= {
    lagMs: 0,
    consecutiveBreaches: 0,
    degraded: false,
    timer: undefined,
  };
  return global[STATE];
}

/**
 * Whether this server process can still serve, from the event loop's point of
 * view. Deliberately blind to the database and every other dependency: one
 * that blips makes every instance report sick at once, and the load balancer
 * then has nowhere to send anything.
 *
 * Production only: in development no sampler runs, so `lagMs` stays 0 and
 * only a shutdown makes it unhealthy.
 */
export function liveness(): Liveness {
  const s = state();
  const shuttingDown = isShuttingDown();
  return {
    healthy: !shuttingDown && !s.degraded,
    shuttingDown,
    lagMs: s.lagMs,
    consecutiveBreaches: s.consecutiveBreaches,
  };
}

/**
 * Records one sample. Degraded once `breaches` in a row are over `maxLagMs`,
 * healthy again at the first one under it: the verdict is live, never
 * latched. Logs once per flip, never per probe.
 */
export function recordLag(lagMs: number, settings: Pick<HealthSettings, "maxLagMs" | "breaches">) {
  const s = state();
  s.lagMs = lagMs;
  s.consecutiveBreaches = lagMs > settings.maxLagMs ? s.consecutiveBreaches + 1 : 0;
  const degraded = s.consecutiveBreaches >= settings.breaches;
  if (degraded && !s.degraded) {
    console.warn(
      `[gemi] Health: degraded (event-loop lag ${Math.round(lagMs)}ms, ${s.consecutiveBreaches} samples in a row over ${settings.maxLagMs}ms).`,
    );
  } else if (!degraded && s.degraded) {
    console.log(`[gemi] Health: recovered (event-loop lag ${Math.round(lagMs)}ms).`);
  }
  s.degraded = degraded;
}

/**
 * Samples the event loop's lag every `intervalMs`: how much later than asked
 * the timer fired. Unref'd, so it never keeps the process alive. Once per
 * process; a second call is a no-op.
 */
export function startLivenessSampler(settings: HealthSettings) {
  const s = state();
  if (s.timer) return;
  let expected = performance.now() + settings.intervalMs;
  s.timer = setInterval(() => {
    const now = performance.now();
    recordLag(Math.max(0, now - expected), settings);
    expected = now + settings.intervalMs;
  }, settings.intervalMs);
  (s.timer as { unref?: () => void }).unref?.();
}

/** Test seam: stops the sampler and forgets every sample. */
export function resetLiveness() {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
  s.lagMs = 0;
  s.consecutiveBreaches = 0;
  s.degraded = false;
}

export function healthSettings(
  env: Record<string, string | undefined> = process.env,
): HealthSettings {
  return {
    paths: healthPaths(env.GEMI_HEALTH_PATH),
    intervalMs: positive("GEMI_HEALTH_INTERVAL_MS", env.GEMI_HEALTH_INTERVAL_MS, 500),
    maxLagMs: positive("GEMI_HEALTH_MAX_LAG_MS", env.GEMI_HEALTH_MAX_LAG_MS, 1000),
    breaches: Math.ceil(positive("GEMI_HEALTH_BREACHES", env.GEMI_HEALTH_BREACHES, 3)),
  };
}

function healthPaths(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [DEFAULT_HEALTH_PATH];
  if (value.trim().toLowerCase() === "off") return [];
  const paths = value
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  const invalid = paths.filter((path) => !path.startsWith("/"));
  if (invalid.length > 0) {
    // Fails the boot, like a bad GEMI_TRUST_PROXY: a probe pointed at a path
    // that silently falls through to the app is the misconfiguration this
    // route exists to remove.
    throw new Error(
      `GEMI_HEALTH_PATH: expected comma-separated paths starting with "/", or "off"; got ${JSON.stringify(value)}.`,
    );
  }
  return paths;
}

function positive(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`[gemi] Ignoring ${name}="${value}": expected a positive number.`);
  return fallback;
}

/**
 * The built-in health route, as the outermost layer of what serves a request:
 * ahead of the app's instrumentation, its global middleware, the domain router
 * and the router, so a probe needs no credentials, is not cached or traced,
 * and is answered the same whatever host it was sent to.
 *
 * `200 ok` while `liveness().healthy`, `503` otherwise. The status is the
 * contract; the body is one word and never a number, since an unauthenticated
 * caller could otherwise time load against a degrading instance.
 */
export function serveHealth(instrumentation: Instrumentation, paths: string[]): Instrumentation {
  if (paths.length === 0) return instrumentation;
  const matches = new Set(paths);
  return async (req, next) => {
    // The substring test first, so an ordinary request pays for no URL parse.
    if (!paths.some((path) => req.url.includes(path)) || !matches.has(new URL(req.url).pathname)) {
      return instrumentation(req, next);
    }
    return closeConnectionWhileShuttingDown(healthResponse(req.method));
  };
}

function healthResponse(method: string): Response {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...headers, Allow: "GET, HEAD" },
    });
  }
  const { healthy, shuttingDown } = liveness();
  const body = healthy ? "ok" : shuttingDown ? "shutting down" : "degraded";
  return new Response(method === "HEAD" ? null : body, {
    status: healthy ? 200 : 503,
    headers,
  });
}
