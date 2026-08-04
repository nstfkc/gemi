// Runs once before the server (httpDev/httpProd) starts — Bun preloads this via
// `--preload` for both `gemi dev` and `gemi start`. Use it for process-wide
// setup that must happen before any request is handled: registering Bun plugins,
// installing polyfills, opening connections, wiring global instrumentation, etc.

// Registers every model under its name in the ORM registry, which is how
// relations resolve their targets and how `UserProvider` — the framework's
// authentication persistence — finds `User`, `Session` and the token models.
//
// Importing the app's own barrel rather than `generated` on purpose: it pulls in
// `generated/index.ts` (registering all of them) and *then* the subclasses
// written over those bases, so a policy on one applies inside nested includes
// too. Importing only `generated` would leave the bases registered and silently
// skip them.
//
// `Kernel.boot()` registers the same modules through `models`, and does it
// whether or not this file exists. This runs earlier — before the server, and
// before anything a preload plugin might do — which is why it is still here.
//
// This import is load-bearing — sign-in raises `ModelNotRegisteredError` without
// it — so unlike the rest of this file it is not safe to delete.
import "@/app/models";

console.log("[app/preload.ts] preloaded before server start");
