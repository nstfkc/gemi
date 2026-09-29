// Vite's HMR websocket needs a port of its own, and in middleware mode Vite
// always picks the same one.
//
// `httpDev` runs Vite with `middlewareMode: true`, so Vite has no HTTP server of
// its own to hang the websocket off — it stands up a second HTTP server just for
// the upgrade. When nothing names a port, that server binds Vite's default 24678
// in *every* `gemi dev` process. `PORT` moves the Bun server and nothing else, so
// a second dev server logs
//
//   WebSocket server error: Port undefined is already in use
//
// and carries on with a dead socket. (Vite logs that failure rather than throwing
// — which is why the symptom is not a crash but pages that hot-reload on the
// *other* checkout's edits: their `/@vite/client` was told 24678, and 24678 is
// the first server's.) So gemi names the port instead of letting Vite default it.
//
// Why derive from the HTTP port rather than just scan for a free one: two dev
// servers must already differ in `PORT` to run at all, so deriving makes their
// HMR ports differ *before* either one binds anything. A scan alone would hand
// both the same port when they start at the same moment, each having probed
// before the other bound. The scan is still here, for the port being taken by
// something that is not a gemi dev server.

const VITE_DEFAULT_HTTP_PORT = 5173;
const VITE_DEFAULT_HMR_PORT = 24678;

// A port is 16 bits.
const MAX_PORT = 65535;

// How far to walk up from the derived port before giving up. Large enough that
// only a pathological machine exhausts it, small enough to fail in well under a
// second rather than appearing to hang.
const SEARCH_WINDOW = 64;

/**
 * Bind-test a port the same way Vite will.
 *
 * Vite calls `wsHttpServer.listen(port, host)` with no host unless one is
 * configured, so its websocket server takes the wildcard address — which is what
 * this binds too. The match matters: a wildcard bind collides with a wildcard
 * *or* a loopback holder, while a loopback bind only collides with loopback. A
 * process holding `127.0.0.1:P` alone therefore reads as free here, correctly —
 * Vite would fail to bind `*:P` against it, but nothing in gemi makes Vite bind
 * loopback-only, so that case cannot arise from a second `gemi dev`.
 *
 * Only `EADDRINUSE` counts as taken. Any other failure — a permission error, an
 * unroutable address — is not something a different port would fix, so it is
 * reported free and left for Vite to surface.
 */
function isPortFree(port: number): boolean {
  try {
    const listener = Bun.listen({
      hostname: "0.0.0.0",
      port,
      socket: { data() {} },
    });
    // `true` closes active connections too. There are none — nothing has been
    // told this port exists yet — but it also makes the close synchronous, so
    // the port is released before the next probe or before Vite binds it.
    listener.stop(true);
    return true;
  } catch (error) {
    return (error as { code?: string })?.code !== "EADDRINUSE";
  }
}

/**
 * Pick the port for Vite's HMR websocket, given the port the dev server's HTTP
 * side is on.
 *
 * `5173` returns `24678` — Vite's two defaults stay paired, so a single dev
 * server behaves exactly as it did before, and anything pointed at 24678 (a
 * firewall rule, a container port mapping, a note in a README) keeps working.
 * Every other HTTP port is offset by the same distance, so distinct `PORT`s
 * always yield distinct HMR ports.
 *
 * @param isFree Injected for tests. Production callers use the bind test above.
 */
export function resolveHmrPort(
  httpPort: number,
  isFree: (port: number) => boolean = isPortFree,
): number {
  let start = VITE_DEFAULT_HMR_PORT + (httpPort - VITE_DEFAULT_HTTP_PORT);

  // A high `PORT` can push the derived port past the top of the range — or so
  // close to it that the walk would run off the end. Fall back to the default
  // and let the scan sort it out; being *adjacent* to another server's port is
  // fine, landing *on* it is what has to be avoided, and the scan does that.
  //
  // There is deliberately no matching floor. The offset is only -5173, so the
  // lowest a real HTTP port can derive is 19505 (from `PORT=0`) — a guard for
  // the bottom of the range would be a branch no input can take.
  if (start > MAX_PORT - SEARCH_WINDOW) {
    start = VITE_DEFAULT_HMR_PORT;
  }

  for (let port = start; port < start + SEARCH_WINDOW; port++) {
    if (isFree(port)) return port;
  }

  throw new Error(
    `Could not find a free port for Vite's HMR websocket: tried ${start}-${
      start + SEARCH_WINDOW - 1
    }. Set one explicitly in gemi.config.ts as \`vite: { server: { ws: { port } } }\`.`,
  );
}
