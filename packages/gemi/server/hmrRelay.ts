import { createServer, type Server as NodeServer } from "node:http";

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

// Vite's HMR websocket, carried on the dev server's own port.
//
// In middleware mode Vite has no HTTP server of its own, so by default it
// stands up a second one for the websocket, on a second port (see
// `hmrPort.ts`), and tells the browser to connect to `<page host>:<that port>`.
// A reverse proxy or tunnel (ngrok, a container port mapping, a phone on the
// LAN through https) only carries the port the page came from, so HMR could
// not connect there, and the client logged connection failures forever.
//
// Vite can attach its websocket to a server it is handed (`server.ws.server`)
// instead, and then tells the browser to connect to the page's own origin. That
// server has to be a Node `http.Server`; the dev server is `Bun.serve`. So:
//
//   - the Node server Vite is handed listens on loopback only, on the port
//     `resolveHmrPort` picked, and answers nothing but websocket upgrades;
//   - `Bun.serve` accepts the browser's upgrade on the page's origin and relays
//     frames both ways to that loopback server.
//
// The relay forwards the browser's `Host` and `Origin` and the request's query
// (the `token`), so Vite still runs its own host and token checks against what
// the browser actually sent.

/** The subprotocols Vite's client opens its sockets with. */
const VITE_PROTOCOLS = new Set(["vite-hmr", "vite-ping"]);

/**
 * Start the loopback Node server Vite attaches its HMR websocket to.
 * Everything but an upgrade gets `426 Upgrade Required`, as Vite's own
 * websocket server answers.
 */
export async function listenHmrServer(port: number): Promise<NodeServer> {
  const server = createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/**
 * The loopback port to relay to, read from the config Vite actually resolved,
 * so an app that set its own `server.ws` in `gemi.config.ts` is relayed to
 * where Vite really is, or not relayed at all. `null` when Vite was not given
 * a server (its websocket is then on a port of its own, and the client goes
 * there directly) or when HMR is off.
 */
export function hmrRelayPort(wsConfig: unknown): number | null {
  if (!wsConfig || typeof wsConfig !== "object") return null;
  const server = (wsConfig as { server?: { address?: () => unknown } }).server;
  const address = server?.address?.();
  if (address && typeof address === "object" && "port" in address) {
    return Number((address as { port: number }).port) || null;
  }
  return null;
}

/** Whether a request is the Vite client opening its HMR (or ping) socket. */
export function isHmrUpgrade(req: Request): boolean {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return false;
  return VITE_PROTOCOLS.has(req.headers.get("sec-websocket-protocol") ?? "");
}

export type HmrRelayData = {
  /** The socket to Vite, already open when the browser's is accepted. */
  upstream: WebSocket;
  /** Frames Vite sent before the browser's socket opened (its `connected`). */
  early: (string | Uint8Array)[];
  browser?: ServerWebSocket<HmrRelayData>;
};

type Frame = string | Uint8Array;

const frameOf = (data: unknown): Frame =>
  typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer);

/**
 * Open the socket to Vite first, and accept the browser's upgrade only once
 * Vite has accepted it. Returns `undefined` once Bun has taken the request
 * over, or a refusal.
 *
 * The order matters. Vite refuses a socket whose host is not in
 * `allowedHosts`, or a cross-origin one without its token. Had the browser's
 * socket been accepted first and closed when Vite refused, the client would
 * read that as "server connection lost", ping (which Vite always answers),
 * and reload the page, forever. Refused before it opens, the client logs one
 * "failed to connect to websocket" and the page keeps working.
 */
export async function upgradeHmr(
  req: Request,
  server: Server<HmrRelayData>,
  port: number,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const protocol = req.headers.get("sec-websocket-protocol") ?? "vite-hmr";
  // `Host` is what Vite's `allowedHosts` check reads; the URL's host is the
  // same value `Bun.serve` derived it from.
  const headers: Record<string, string> = {
    host: req.headers.get("host") ?? url.host,
  };
  const origin = req.headers.get("origin");
  if (origin) headers.origin = origin;

  const upstream = new WebSocket(
    `ws://127.0.0.1:${port}${url.pathname}${url.search}`,
    {
      protocols: [protocol],
      headers,
    } as any,
  );
  upstream.binaryType = "arraybuffer";
  const data: HmrRelayData = { upstream, early: [] };

  upstream.onmessage = (event) => {
    const frame = frameOf(event.data);
    if (data.browser) data.browser.send(frame);
    else data.early.push(frame);
  };
  upstream.onclose = (event) => {
    data.browser?.close(sendableCloseCode(event.code), event.reason);
  };
  upstream.onerror = () => {
    // A `close` follows; it ends the browser's socket if there is one.
  };

  const opened = await new Promise<boolean>((resolve) => {
    upstream.addEventListener("open", () => resolve(true), { once: true });
    upstream.addEventListener("close", () => resolve(false), { once: true });
  });
  if (!opened) {
    return new Response("Vite refused the HMR websocket", { status: 403 });
  }

  const upgraded = server.upgrade(req, {
    // The browser fails a connection whose response does not echo the
    // subprotocol it asked for.
    headers: { "Sec-WebSocket-Protocol": protocol },
    data,
  });
  if (!upgraded) {
    upstream.close();
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  return undefined;
}

// A close code that may be sent in a close frame. 1005, 1006 and 1015 are
// reported locally and never sent.
function sendableCloseCode(code: number): number {
  if (
    code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1014)
  ) {
    return code;
  }
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

/** `Bun.serve`'s `websocket` option: relays frames to and from Vite. */
export const hmrRelayHandler: WebSocketHandler<HmrRelayData> = {
  open(ws: ServerWebSocket<HmrRelayData>) {
    const data = ws.data;
    for (const frame of data.early) ws.send(frame);
    data.early = [];
    data.browser = ws;
    // Vite may have hung up while the upgrade was in flight.
    if (data.upstream.readyState !== WebSocket.OPEN) ws.close(1000);
  },
  message(ws: ServerWebSocket<HmrRelayData>, message) {
    if (ws.data.upstream.readyState === WebSocket.OPEN) {
      ws.data.upstream.send(message);
    }
  },
  close(ws: ServerWebSocket<HmrRelayData>) {
    const { upstream } = ws.data;
    if (upstream.readyState <= WebSocket.OPEN) upstream.close();
  },
};
