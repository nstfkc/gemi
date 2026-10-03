import type { Server } from "bun";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  type HmrRelayData,
  hmrRelayHandler,
  hmrRelayPort,
  isHmrUpgrade,
  listenHmrServer,
  upgradeHmr,
} from "./hmrRelay";

/**
 * #733, end to end: a real Vite dev server in middleware mode, its websocket
 * attached to the loopback server `httpDev` hands it, and a `Bun.serve` that
 * relays the browser's socket there — the same wiring as `httpDev`, minus the
 * app. The browser side is a plain `WebSocket` opened the way Vite's client
 * opens it: to the page's own port, with the `vite-hmr` subprotocol and the
 * token in the query.
 */

let vite: ViteDevServer;
let page: Server<HmrRelayData>;
let hmrServer: Awaited<ReturnType<typeof listenHmrServer>>;

beforeAll(async () => {
  // Port 0: the OS picks a free one, so the test never collides with a dev
  // server already running on the machine.
  hmrServer = await listenHmrServer(0);
  vite = await createServer({
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, ws: { server: hmrServer } as any },
  });
  const relayPort = hmrRelayPort(vite.config.server.ws);
  page = Bun.serve<HmrRelayData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, server) =>
      relayPort !== null && isHmrUpgrade(req)
        ? upgradeHmr(req, server, relayPort)
        : new Response("page"),
    websocket: hmrRelayHandler,
  });
});

afterAll(async () => {
  page?.stop(true);
  await vite?.close();
  hmrServer?.close();
});

function openHmrSocket(
  token: string,
  origin = `http://127.0.0.1:${page.port}`,
) {
  return new WebSocket(`ws://127.0.0.1:${page.port}/?token=${token}`, {
    protocols: ["vite-hmr"],
    headers: { origin },
  } as any);
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      "message",
      (event) => resolve(JSON.parse(String(event.data))),
      {
        once: true,
      },
    );
    ws.addEventListener(
      "close",
      (event) => reject(new Error(`closed ${event.code}`)),
      {
        once: true,
      },
    );
  });
}

describe("the HMR relay", () => {
  test("is told where Vite's websocket server is", () => {
    expect(hmrRelayPort(vite.config.server.ws)).toBe(
      (hmrServer.address() as any).port,
    );
  });

  test("Vite's client is told to connect to the page's own origin", async () => {
    // `__HMR_PORT__` null makes the client fall back to `location.port`, which
    // is what puts the socket on the port a tunnel carries.
    const res = await vite.transformRequest("/@vite/client");
    expect(res?.code).toMatch(/const hmrPort = null;/);
  });

  test("carries Vite's messages to the browser over the page's port", async () => {
    const ws = openHmrSocket(vite.config.webSocketToken);
    // Vite greets every new client.
    expect(await nextMessage(ws)).toEqual({ type: "connected" });
    expect(ws.protocol).toBe("vite-hmr");

    const received = nextMessage(ws);
    vite.ws.send({ type: "custom", event: "http-reload" });
    expect(await received).toEqual({ type: "custom", event: "http-reload" });
    ws.close();
  });

  test("carries the browser's messages to Vite", async () => {
    const got = new Promise((resolve) =>
      vite.ws.on("gemi:test", (data) => resolve(data)),
    );
    const ws = openHmrSocket(vite.config.webSocketToken);
    await nextMessage(ws);

    ws.send(
      JSON.stringify({
        type: "custom",
        event: "gemi:test",
        data: { from: "browser" },
      }),
    );
    expect(await got).toEqual({ from: "browser" });
    ws.close();
  });

  test("still lets Vite refuse a cross-origin socket without its token", async () => {
    const ws = openHmrSocket("wrong-token", "https://evil.example");
    const closed = await new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    expect(closed).not.toBe(1000);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe("isHmrUpgrade", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://localhost/", { headers });

  test("matches Vite's client sockets and nothing else", () => {
    expect(
      isHmrUpgrade(
        req({ upgrade: "websocket", "sec-websocket-protocol": "vite-hmr" }),
      ),
    ).toBe(true);
    expect(
      isHmrUpgrade(
        req({ upgrade: "websocket", "sec-websocket-protocol": "vite-ping" }),
      ),
    ).toBe(true);
    expect(
      isHmrUpgrade(
        req({ upgrade: "websocket", "sec-websocket-protocol": "chat" }),
      ),
    ).toBe(false);
    expect(isHmrUpgrade(req({ "sec-websocket-protocol": "vite-hmr" }))).toBe(
      false,
    );
    expect(isHmrUpgrade(req({}))).toBe(false);
  });
});
