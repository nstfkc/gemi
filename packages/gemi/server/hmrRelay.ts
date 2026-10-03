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
  /** `ws://127.0.0.1:<port><path>?<query>` */
  target: string;
  protocol: string;
  headers: Record<string, string>;
  upstream?: WebSocket;
  /** Frames from the browser that arrived before the upstream opened. */
  pending: (string | Buffer)[];
};

/**
 * Upgrade the browser's socket and mark it for relaying to `port`. Returns
 * `undefined` once Bun has taken the request over, or a `Response` when the
 * upgrade could not be made.
 */
export function upgradeHmr(
  req: Request,
  server: Server<HmrRelayData>,
  port: number,
): Response | undefined {
  const url = new URL(req.url);
  const protocol = req.headers.get("sec-websocket-protocol") ?? "vite-hmr";
  // `Host` is what Vite's `allowedHosts` check reads; the URL's host is the
  // same value `Bun.serve` derived it from.
  const headers: Record<string, string> = {
    host: req.headers.get("host") ?? url.host,
  };
  const origin = req.headers.get("origin");
  if (origin) headers.origin = origin;
  const upgraded = server.upgrade(req, {
    // The browser fails a connection whose response does not echo the
    // subprotocol it asked for.
    headers: { "Sec-WebSocket-Protocol": protocol },
    data: {
      target: `ws://127.0.0.1:${port}${url.pathname}${url.search}`,
      protocol,
      headers,
      pending: [],
    },
  });
  return upgraded
    ? undefined
    : new Response("WebSocket upgrade failed", { status: 400 });
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
    const upstream = new WebSocket(data.target, {
      protocols: [data.protocol],
      headers: data.headers,
    } as any);
    upstream.binaryType = "arraybuffer";
    data.upstream = upstream;

    upstream.onopen = () => {
      for (const frame of data.pending) upstream.send(frame);
      data.pending = [];
    };
    upstream.onmessage = (event) => {
      ws.send(
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer),
      );
    };
    upstream.onclose = (event) => {
      ws.close(sendableCloseCode(event.code), event.reason);
    };
    upstream.onerror = () => {
      // A `close` follows, which ends the browser's socket.
    };
  },
  message(ws: ServerWebSocket<HmrRelayData>, message) {
    const { upstream, pending } = ws.data;
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(message);
    } else {
      pending.push(message);
    }
  },
  close(ws: ServerWebSocket<HmrRelayData>) {
    const upstream = ws.data.upstream;
    if (upstream && upstream.readyState <= WebSocket.OPEN) {
      upstream.close();
    }
  },
};
