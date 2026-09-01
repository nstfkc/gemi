import { App } from "../app";
import { Kernel } from "../kernel";
import { projectRoot } from "../support/discover";
import { Instrumentation } from "./types";
import { watchEnv } from "./watchEnv";

export class Server {
  private app: App;
  private instrumentation: Instrumentation;

  constructor(params: { kernel: new () => Kernel; instrumentation?: Instrumentation }) {
    this.app = new App({ kernel: params.kernel });
    this.instrumentation =
      params.instrumentation ??
      ((req: Request, next: (req: Request) => Promise<Response>) => next(req));
  }

  async start() {
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

    // Phase two of the boot. `new App({ kernel })` already ran every provider's
    // synchronous `register()`; this awaits their `boot()` before the first
    // request is served.
    await this.app.waitForBoot();

    // Dynamic import so each mode only pulls in its own code: `httpDev` drags in
    // Vite (dev-only) and `httpProd` reads the built `dist/` manifests — neither
    // should load in the other environment.
    if (process.env.NODE_ENV === "production") {
      const { httpProd } = await import("./httpProd.js");
      await httpProd(this.app, this.instrumentation.bind(this));
    } else {
      // Dev only: reload `.env` into process.env on change so config edits take
      // effect without restarting the dev server (Bun reads `.env` only at
      // startup, even under `--hot`).
      watchEnv();
      const { httpDev } = await import("./httpDev.js");
      await httpDev(this.app, this.instrumentation.bind(this));
    }
  }
}
