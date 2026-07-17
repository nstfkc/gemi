// Runs once before the server (httpDev/httpProd) starts — Bun preloads this via
// `--preload` for both `gemi dev` and `gemi start`. Use it for process-wide
// setup that must happen before any request is handled: registering Bun plugins,
// installing polyfills, opening connections, wiring global instrumentation, etc.
// Remove this file if the app doesn't need any preload step.
console.log("[app/preload.ts] preloaded before server start");
