import { plugin } from "bun";
import { gemiPlugin } from "./plugin";

// Registers the gemi custom-request transform as a Bun *runtime* plugin. Loaded
// via `bun --hot --preload gemi/bun/preload app/server.ts` (see the `dev`
// command in `bin/gemi.ts`) so controllers/routes imported by the dev server are
// transformed on import — the runtime counterpart to `gemiPlugin()` in the
// `Bun.build` server build. Keep this module lightweight: it must not pull in
// any side-effecting gemi code, only the transform itself.
plugin(gemiPlugin());
