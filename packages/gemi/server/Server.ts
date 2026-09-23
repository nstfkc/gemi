import { App } from "../app";
import { Kernel } from "../kernel";
import { projectRoot } from "../support/discover";
import {
  closeConnectionWhileShuttingDown,
  drain,
  installShutdownSignals,
  shutdownSettings,
  type ShutdownSettings,
} from "./shutdown";
import { Instrumentation } from "./types";
import { watchEnv } from "./watchEnv";

export class Server {
  private app: App;
  private instrumentation: Instrumentation;
  private handleSignals: boolean;
  private server: Bun.Server<unknown> | undefined;
  private stopping: Promise<number> | undefined;
  private settings: ShutdownSettings | undefined;

  constructor(params: {
    kernel: new () => Kernel;
    instrumentation?: Instrumentation;
    /**
     * Drain on `SIGTERM`/`SIGINT` and exit — production only. `false` leaves
     * the signals to the app, which can call `stop()` itself.
     */
    handleSignals?: boolean;
  }) {
    this.app = new App({ kernel: params.kernel });
    this.handleSignals = params.handleSignals ?? true;
    const instrumentation =
      params.instrumentation ??
      ((req: Request, next: (req: Request) => Promise<Response>) => next(req));
    this.instrumentation = async (req, next) =>
      closeConnectionWhileShuttingDown(await instrumentation(req, next));
  }

  /**
   * Boots the application and starts listening. Resolves with the `Bun.Server`
   * once it is accepting requests.
   */
  async start(): Promise<Bun.Server<unknown>> {
    // Before the boot, not after: `httpDev`/`httpProd` set this too, but they
    // are imported below — after every provider's `boot()` has run — so a
    // service that resolves a path during boot used to read `undefined`
    // (`services/logging`, #423). Same rule `httpProd` computes it with, so
    // the assignment it makes a moment later is the same value.
    //
    // It doubles as the marker for "this process is serving": nothing else
    // sets `ROOT_DIR`, so a console command or a migration — which boot the
    // same providers through `runConsole` — can tell that it is not one, and
    // skip work that only a server should do at boot.
    process.env.ROOT_DIR = projectRoot();

    // Read once, ahead of the boot, so the signal handling below and the mode
    // that starts after the boot cannot disagree: whatever a provider's
    // `boot()` does to the environment, this process is the server it was
    // started as.
    const production = process.env.NODE_ENV === "production";

    if (production) {
      // Before the boot, not just before listening: the whole start-up is a
      // window in which a signal can arrive, and the slow part of it is the
      // boot — a connection pool, the config, the dictionaries. A rolling
      // update that `SIGTERM`s a pod two seconds in finds no listener
      // installed, and the default action for both signals is to kill the
      // process on the spot: no provider's `shutdown()`, no pool closed,
      // nothing flushed. Installing here makes that a drain like any other.
      // `stop()` handles a server that does not exist yet (nothing to close,
      // requests cannot be in flight) and `Application.shutdown` calls the
      // hooks of providers that registered but never booted, swallowing
      // whatever they throw — half a boot is exactly when a hook is most
      // likely to trip over something it expected `boot()` to have made.
      if (this.handleSignals) installShutdownSignals(() => this.stop());
      // Read now, so a bad value is warned about while the operator is
      // watching the deploy, not first at the shutdown it spoils — and so a
      // signal during the boot drains on the configured budget rather than on
      // whatever `stop()` reads at the time.
      this.settings = shutdownSettings();
    }

    // Phase two of the boot. `new App({ kernel })` already ran every provider's
    // synchronous `register()`; this awaits their `boot()` before the first
    // request is served.
    await this.app.waitForBoot();

    // Dynamic import so each mode only pulls in its own code: `httpDev` drags in
    // Vite (dev-only) and `httpProd` reads the built `dist/` manifests — neither
    // should load in the other environment.
    if (production) {
      const { httpProd } = await import("./httpProd.js");
      this.server = await httpProd(this.app, this.instrumentation.bind(this));
    } else {
      // Dev only: reload `.env` into process.env on change so config edits take
      // effect without restarting the dev server (Bun reads `.env` only at
      // startup, even under `--hot`). No signal handling here: `bun --hot`
      // re-runs this on every reload, and a Ctrl+C in development should stop
      // the server now, not after a drain.
      watchEnv();
      const { httpDev } = await import("./httpDev.js");
      this.server = await httpDev(this.app, this.instrumentation.bind(this));
    }
    return this.server;
  }

  /**
   * Stops the server gracefully and resolves with the exit code it earned: 0
   * when the in-flight requests drained and every provider shut down in time,
   * 1 otherwise. Does not exit the process — the signal handler does that.
   *
   * The order is `drain` in `./shutdown`: `isShuttingDown()` turns true, the
   * listener closes, in-flight requests finish under the grace period, then
   * every provider's `shutdown()` runs in reverse registration order.
   * Idempotent: a second call returns the first call's promise. Settings
   * default to the `GEMI_SHUTDOWN_*` environment variables.
   */
  stop(settings: Partial<ShutdownSettings> = {}): Promise<number> {
    this.stopping ??= drain({
      server: this.server,
      shutdownProviders: (options) => this.app.shutdown(options),
      settings: { ...(this.settings ?? shutdownSettings()), ...settings },
    });
    return this.stopping;
  }
}
