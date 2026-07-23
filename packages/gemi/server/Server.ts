import { App } from "../app";
import { Kernel } from "../kernel";
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
