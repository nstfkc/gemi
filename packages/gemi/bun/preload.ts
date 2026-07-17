import { plugin } from "bun";
import { gemiPlugin } from "./plugin";
import { loadGemiConfig } from "../config/load";

// Registers gemi's custom-request transform plus any Bun plugins the app
// declares in `gemi.config.ts` as Bun *runtime* plugins. Loaded via
// `bun --hot|--preload gemi/bun/preload app/server.ts` (see the `dev`/`start`
// commands in `bin/gemi.ts`) so controllers/routes are transformed on import —
// the runtime counterpart to the same plugins passed to `Bun.build` in the
// server build. Top-level `await` here completes before app code loads.
plugin(gemiPlugin());

const config = await loadGemiConfig(process.cwd());
for (const p of config.bun?.plugins ?? []) {
  plugin(p);
}
