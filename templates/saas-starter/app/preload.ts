// Runs once before the server (httpDev/httpProd) starts — Bun preloads this via
// `--preload` for both `gemi dev` and `gemi start`. Use it for process-wide
// setup that must happen before any request is handled: registering Bun plugins,
// installing polyfills, opening connections, wiring global instrumentation, etc.

// Registers every model under its name in the ORM registry, which is how
// relations resolve their targets and how `UserProvider` — the framework's
// authentication persistence — finds `User`, `Session` and the token models.
//
// Importing `User` rather than `generated` on purpose: it pulls in
// `generated/index.ts` (registering all of them) and *then* re-registers "User"
// against the app's own subclass, so a policy added there applies inside nested
// includes too. Importing only `generated` would leave the base registered and
// silently skip it.
//
// This import is load-bearing — sign-in raises `ModelNotRegisteredError` without
// it — so unlike the rest of this file it is not safe to delete.
import "@/app/models/User";

console.log("[app/preload.ts] preloaded before server start");
