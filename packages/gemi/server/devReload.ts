import type { Instrumentation } from "./types";

/**
 * The application `gemi dev` is serving, kept across `bun --hot` reloads so
 * the next reload can shut it down (#652).
 *
 * A reload re-evaluates the whole module graph and `Server.start()` boots a
 * fresh application, with its own providers: its own database pool, Redis
 * client, scheduler and queue. Nothing used to stop the one it replaced, so
 * every save left a pool of idle Postgres connections behind (ten, Bun's
 * default) until the server's `max_connections` ran out for every process
 * sharing it.
 *
 * On `globalThis` under a registry symbol, like `__gemiVite`, because the
 * module holding it is re-evaluated too. What is read back after a reload is
 * therefore an instance of the *previous* graph's class, so it is typed by
 * the one method called on it and checked for that method before the call.
 */
const CURRENT = Symbol.for("gemi.server.devGeneration");

export type RetireOptions = {
  /**
   * How long to wait for the requests the replaced application is still
   * serving before its providers shut down under them.
   */
  graceMs: number;
  /** The deadline `Application.shutdown` shares between the providers. */
  providerTimeoutMs: number;
};

/**
 * Ten seconds for the old application's requests, five for its providers.
 * Nothing waits on either but the old pool staying open a little longer. A
 * request that outlives the grace — a server-sent-events stream is open for as
 * long as its tab is — loses its database under it, which after a reload it
 * would soon anyway: the page is told to refetch against the new code.
 */
export const devRetireDefaults: RetireOptions = { graceMs: 10_000, providerTimeoutMs: 5_000 };

/** The part of `App` a reload shuts down. */
type Shuttable = { shutdown(options?: { timeoutMs?: number }): Promise<unknown> };

type Retiring = { retire(options: RetireOptions): Promise<void> };

/**
 * One application `gemi dev` served, with a count of the requests it is
 * serving so a reload can let them finish before shutting it down.
 *
 * Counted until the handler resolves with a `Response`, not until its body
 * has been sent. Wrapping every body to see its end — Vite's module responses
 * included — is a cost paid on each of the hundreds of requests a dev page
 * load makes, for the rare stream that spans a save. A query such a stream has
 * already sent still finishes: the pool's `close()` waits for it.
 */
export class DevGeneration {
  private inFlight = 0;
  private waiters = new Set<() => void>();

  constructor(private readonly app: Shuttable) {}

  /** Wraps `instrumentation` so every request through it is counted. */
  track(instrumentation: Instrumentation): Instrumentation {
    return async (req, next) => {
      this.inFlight++;
      try {
        return await instrumentation(req, next);
      } finally {
        this.inFlight--;
        if (this.inFlight === 0) this.wake();
      }
    };
  }

  /** Requests this application is serving right now. */
  get pending(): number {
    return this.inFlight;
  }

  /**
   * Waits up to `graceMs` for the requests in flight, then shuts the
   * application's providers down. Never rejects: it runs detached from the
   * reload, where a rejection would surface as an unhandled one and land in
   * the browser's error overlay, for a failure in code the save replaced.
   */
  async retire({ graceMs, providerTimeoutMs }: RetireOptions): Promise<void> {
    try {
      await this.idle(graceMs);
      // `.then` so a synchronous throw from `shutdown` lands in the catch too.
      await Promise.resolve().then(() => this.app.shutdown({ timeoutMs: providerTimeoutMs }));
    } catch (error) {
      reportFailure(error);
    }
  }

  private idle(timeoutMs: number): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  private wake() {
    // Each `done` deletes itself, which a `Set` being iterated allows.
    for (const done of this.waiters) done();
  }
}

/**
 * Records `next` as the application `gemi dev` is serving and retires the one
 * it replaced, if any. Call it once `next` is serving — after `Bun.serve` has
 * swapped the fetch handler — so that no new request reaches the application
 * being shut down, and the ones already on it can finish.
 *
 * The caller does not wait for the returned retirement: the reload is done,
 * and the old application's requests and providers finishing is no reason to
 * hold up the new one. The promise is for tests, and never rejects.
 */
export function replaceDevGeneration(
  next: DevGeneration,
  options: RetireOptions = devRetireDefaults,
): Promise<void> {
  const global = globalThis as { [CURRENT]?: Partial<Retiring> };
  const previous = global[CURRENT];
  global[CURRENT] = next;
  if (!previous || previous === next || typeof previous.retire !== "function") {
    return Promise.resolve();
  }
  const retire = previous.retire.bind(previous);
  // Guarded like `retire` itself, because this one is the previous graph's code.
  return Promise.resolve()
    .then(() => retire(options))
    .catch(reportFailure);
}

function reportFailure(error: unknown) {
  console.error("[gemi] Shutting down the application a reload replaced failed:", error);
}

/** Test seam: forget the application a previous test left as current. */
export function resetDevGeneration() {
  delete (globalThis as { [CURRENT]?: unknown })[CURRENT];
}
