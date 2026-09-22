import { constants } from "node:os";
import type { ShutdownReport } from "../foundation/Application";

// On `globalThis` under a registry symbol rather than in a module variable, so
// the flag an app's health route reads is the one the server set even when two
// copies of this module are loaded — the built CLI bundles its own gemi (see
// `app/App.ts`), and `bun --hot` re-evaluates every module on a reload.
const STATE = Symbol.for("gemi.server.shutdown");

type ShutdownState = { shuttingDown: boolean };

function state(): ShutdownState {
  const global = globalThis as { [STATE]?: ShutdownState };
  global[STATE] ??= { shuttingDown: false };
  return global[STATE];
}

/**
 * True from the moment this server process has been told to stop — before it
 * stops accepting connections — until it exits.
 *
 * gemi has no health endpoint of its own, so taking an instance out of a load
 * balancer is the app's health route's job: answer it with a `503` while this
 * is true, and the platform's probe pulls the instance while the in-flight
 * requests are still draining. Every response sent in that window also carries
 * `Connection: close`, so a client that honours it opens its next request on a
 * new connection — one the load balancer can route elsewhere — instead of
 * reusing this one.
 */
export function isShuttingDown(): boolean {
  return state().shuttingDown;
}

export function markShuttingDown() {
  state().shuttingDown = true;
}

/** Test seam: a fresh process starts false, and so should each test. */
export function resetShuttingDown() {
  state().shuttingDown = false;
}

export type ShutdownSettings = {
  /**
   * From the signal to the end of the request drain, in milliseconds — the
   * delay below included. Requests still in flight when it runs out are
   * abandoned. `GEMI_SHUTDOWN_TIMEOUT`, in seconds; default 20.
   */
  timeoutMs: number;
  /**
   * How long to keep accepting new requests after `isShuttingDown()` turns
   * true, in milliseconds, so a health probe can see the `503` and the load
   * balancer stop routing here before the listener closes.
   * `GEMI_SHUTDOWN_DELAY`, in seconds; default 0.
   */
  delayMs: number;
  /**
   * The shared deadline for every provider's `shutdown()`, in milliseconds,
   * after the drain. `GEMI_SHUTDOWN_PROVIDER_TIMEOUT`, in seconds; default 5.
   */
  providerTimeoutMs: number;
};

/**
 * 20s to drain plus 5s for providers is 25s: under the 30s that Kubernetes,
 * Azure Container Apps and ECS give by default between `SIGTERM` and `SIGKILL`,
 * with 5s left for the `gemi start` relay, the process exit and clock skew
 * between the platform's timer and ours. A platform with a shorter window
 * (Cloud Run's 10s, Fly's 5s) needs these lowered, not the other way round —
 * a drain that outlives the grace period ends in the same `SIGKILL` as no drain.
 *
 * The delay defaults to 0 because it only helps where a probe is watching, and
 * otherwise every shutdown would pay it for nothing.
 */
export function shutdownSettings(
  env: Record<string, string | undefined> = process.env,
): ShutdownSettings {
  const settings = {
    timeoutMs: seconds(env.GEMI_SHUTDOWN_TIMEOUT, 20),
    delayMs: seconds(env.GEMI_SHUTDOWN_DELAY, 0),
    providerTimeoutMs: seconds(env.GEMI_SHUTDOWN_PROVIDER_TIMEOUT, 5),
  };
  // Warned, not clamped: the delay is sized to a probe, the timeout to the
  // platform's grace period, and which one is wrong only the operator knows.
  // Left alone, every shutdown spends the whole timeout in the delay and then
  // abandons whatever is in flight without draining it.
  if (settings.delayMs > 0 && settings.delayMs >= settings.timeoutMs) {
    console.warn(
      `[gemi] GEMI_SHUTDOWN_DELAY (${settings.delayMs / 1000}s) leaves no time to drain within GEMI_SHUTDOWN_TIMEOUT (${settings.timeoutMs / 1000}s); in-flight requests will be abandoned on every shutdown. Raise the timeout.`,
    );
  }
  return settings;
}

function seconds(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === "" ? NaN : Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1000;
  if (value !== undefined) {
    console.warn(`[gemi] Ignoring shutdown setting "${value}": expected a number of seconds.`);
  }
  return fallback * 1000;
}

/** The part of `Bun.Server` a drain needs. */
export type Stoppable = {
  stop(closeActiveConnections?: boolean): Promise<void>;
  readonly pendingRequests: number;
};

/**
 * The shutdown sequence, in its order:
 *
 * 1. `isShuttingDown()` turns true — first, so the health route answers `503`
 *    and responses carry `Connection: close` while the listener is still open.
 * 2. After `delayMs`, the listener closes (`server.stop()` without force):
 *    new connections are refused, while every request in flight — a streamed
 *    response included, to its last chunk — runs to completion.
 * 3. That completion is awaited until `timeoutMs` from the start.
 * 4. Every provider's `shutdown()` runs, reverse order, `providerTimeoutMs`.
 *
 * Resolves with the exit code: 0 when every step finished in time, 1 when the
 * drain was cut short or a provider failed or overran.
 *
 * Two things `stop()` does not do, both measured on Bun 1.3.14, and both why
 * the process exit that follows is what actually ends the server:
 *
 * - It does not close a kept-alive connection. One that is idle when the
 *   listener closes stays open, and a request sent down it afterwards is
 *   served. That is what the `Connection: close` on every response in the
 *   window is for: a client (or a proxy in front) that honours it opens its
 *   next request on a new connection, which the closed listener refuses.
 * - `stop(true)` issued after a graceful `stop()` does not cut the remaining
 *   requests off; it waits for the same ones. It is still called when the
 *   drain times out, for a Bun that does, but nothing here depends on it.
 */
export async function drain(params: {
  server: Stoppable | undefined;
  shutdownProviders: (options: { timeoutMs: number }) => Promise<ShutdownReport>;
  settings: ShutdownSettings;
}): Promise<number> {
  const { server, settings } = params;
  const deadline = Date.now() + settings.timeoutMs;

  markShuttingDown();
  console.log(
    `[gemi] Shutting down: draining in-flight requests (up to ${settings.timeoutMs / 1000}s).`,
  );

  let drained = true;
  if (server) {
    if (settings.delayMs > 0) {
      await sleep(Math.min(settings.delayMs, deadline - Date.now()));
    }
    const stopped = server.stop();
    drained = await settlesWithin(stopped, deadline - Date.now());
    if (!drained) {
      console.error(
        `[gemi] Shutdown grace period elapsed with ${server.pendingRequests} request(s) still in flight; abandoning them.`,
      );
      void server.stop(true).catch(() => {});
    }
  }

  const report = await params.shutdownProviders({ timeoutMs: settings.providerTimeoutMs });
  const clean = drained && report.failed.length === 0 && report.timedOut.length === 0;
  console.log(`[gemi] Shutdown ${clean ? "complete" : "finished with errors"}.`);
  return clean ? 0 : 1;
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * `Connection: close` on a response sent while shutting down, so the client's
 * next request opens a connection — which the load balancer can send elsewhere
 * — instead of reusing this one.
 *
 * The spec makes some responses' headers immutable (a `Response.redirect`, a
 * proxied `fetch`), and setting one throws. Bun 1.3.14 lets both be set, so
 * the copy is for a Bun that follows the spec — a throw here would turn every
 * such response in the drain window into a 500.
 */
export function closeConnectionWhileShuttingDown(res: Response): Response {
  if (!isShuttingDown()) return res;
  try {
    res.headers.set("Connection", "close");
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set("Connection", "close");
    return copy;
  }
}

// Installed once per process, not once per `Server`: a listener per instance
// would each start a shutdown of its own, and read the other's signal as the
// second one.
const SIGNALS_INSTALLED = Symbol.for("gemi.server.signalsInstalled");

/**
 * A repeat of the first signal inside this window is the same shutdown
 * delivered twice, not an operator asking to skip the drain. One shutdown
 * routinely arrives more than once, milliseconds apart: Ctrl+C on
 * `bun run start` reaches the server directly (the whole foreground group is
 * signalled), and again through `gemi start`'s relay — twice over, since
 * `bun run` forwards it to `gemi start` too. systemd's default
 * `KillMode=control-group` and `tini -g` do the same to every process in the
 * group. A person pressing Ctrl+C again is well outside a second.
 */
const REPEAT_WINDOW_MS = 1000;

/**
 * `SIGTERM` or `SIGINT` runs `stop` and exits with the code it resolves with.
 * Another signal of either kind, more than `repeatWindowMs` after the first,
 * exits at once with `128 + n` — an operator pressing Ctrl+C again does not
 * want to wait out the grace period. Without a listener the first signal would
 * do that too: the default action for both is to terminate the process on the
 * spot.
 */
export function installShutdownSignals(
  stop: () => Promise<number>,
  options: { repeatWindowMs?: number } = {},
) {
  const global = globalThis as { [SIGNALS_INSTALLED]?: boolean };
  if (global[SIGNALS_INSTALLED]) return;
  global[SIGNALS_INSTALLED] = true;

  const repeatWindowMs = options.repeatWindowMs ?? REPEAT_WINDOW_MS;
  let receivedAt: number | undefined;
  const onSignal = (signal: "SIGTERM" | "SIGINT") => {
    if (receivedAt !== undefined) {
      if (Date.now() - receivedAt < repeatWindowMs) return;
      console.error(`[gemi] ${signal} received again; exiting without waiting for the drain.`);
      process.exit(128 + constants.signals[signal]);
    }
    receivedAt = Date.now();
    console.log(`[gemi] ${signal} received.`);
    stop().then(
      (code) => process.exit(code),
      (error) => {
        console.error("[gemi] Shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}
