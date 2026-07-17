import { App } from "../app";
import { Kernel } from "../kernel";

export class Server {
  private app: App;

  constructor(params: { kernel: new () => Kernel }) {
    this.app = new App({ kernel: params.kernel });
  }

  async start() {
    // Dynamic import so each mode only pulls in its own code: `httpDev` drags in
    // Vite (dev-only) and `httpProd` reads the built `dist/` manifests — neither
    // should load in the other environment.
    if (process.env.NODE_ENV === "production") {
      const { httpProd } = await import("./httpProd.js");
      await httpProd(this.app);
    } else {
      const { httpDev } = await import("./httpDev.js");
      await httpDev(this.app);
    }
  }

  static app() {
    return this.app;
  }
}
