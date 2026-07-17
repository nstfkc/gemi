import path from "node:path";
import { App } from "../app";

// Build the app straight from the kernel for build-time / tooling use. The
// runtime entry (`app/server.ts`) can't be imported for this because it starts
// a server on import and exports no `app`.
export async function loadApp() {
  const { default: Kernel } = await import(
    path.resolve("./app/kernel/Kernel.ts")
  );
  return new App({ kernel: Kernel });
}
