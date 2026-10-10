import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * That `httpDev` actually hands Vite an HMR port, and derives it from the port
 * the app is being served on.
 *
 * `hmrPort.test.ts` covers how the port is *chosen*; this covers that the choice
 * reaches Vite at all. Without it, deleting the `ws` option from the Vite config
 * would leave every test in this repo green while restoring the bug — the two
 * dev servers fighting over 24678 that #611 is about.
 *
 * `resolveHmrPort` is stubbed rather than run for real. It ends in a bind test,
 * so a test asserting the true default here would pass or fail on whether 24678
 * happens to be free on the machine running it — and on a developer's machine,
 * with a `gemi dev` already up, it is not. The stub keeps this file about the
 * wiring and leaves the choosing to the suite that injects its own prober.
 */

const { createdConfigs, servedOptions, resolveHmrPort } = vi.hoisted(() => ({
  createdConfigs: [] as any[],
  servedOptions: [] as any[],
  // Deliberately not a real derivation: an identity or a constant could be
  // matched by accident by a wiring bug, whereas this offset cannot.
  resolveHmrPort: vi.fn((httpPort: number) => httpPort + 10_000),
}));

vi.mock("./hmrPort", () => ({ resolveHmrPort }));

// The loopback server Vite's websocket is attached to. Stubbed so this file
// binds nothing; `hmrRelay.test.ts` runs the real one against a real Vite.
// `upgradeHmr` is stubbed too: the real one dials Vite before accepting.
const { listenHmrServer, upgradeHmr } = vi.hoisted(() => ({
  listenHmrServer: vi.fn(async (port: number) => ({ address: () => ({ port }) })),
  upgradeHmr: vi.fn(async () => undefined),
}));
vi.mock("./hmrRelay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hmrRelay")>()),
  listenHmrServer,
  upgradeHmr,
}));

vi.mock("vite", () => ({
  createServer: vi.fn(async (config: any) => {
    createdConfigs.push(config);
    return { ws: { send: vi.fn() }, middlewares: () => {}, config };
  }),
}));

vi.mock("../vite", () => ({ default: () => [] }));

vi.mock("./devFetch", () => ({
  createDevFetch: () => () => new Response("ok"),
  sendErrorToClient: vi.fn(),
  ssrRunner: () => ({ clearCache: vi.fn() }),
  viteErrorPayload: {},
}));

vi.mock("./banner", () => ({ printStartupBanner: vi.fn() }));

// `sockets` is the broadcast endpoint: none unless a test sets one.
let sockets: any = null;
const app = { devAllowedHosts: () => true, sockets: () => sockets } as any;
const instrumentation = {} as any;

async function startDev() {
  const { httpDev } = await import("./httpDev");
  return httpDev(app, instrumentation);
}

let originalPort: string | undefined;
let originalIdleTimeout: string | undefined;

beforeEach(() => {
  originalPort = process.env.PORT;
  originalIdleTimeout = process.env.SERVER_IDLE_TIMEOUT;
  createdConfigs.length = 0;
  servedOptions.length = 0;
  resolveHmrPort.mockClear();
  listenHmrServer.mockClear();
  upgradeHmr.mockClear();
  // `httpDev` caches its Vite server here across `bun --hot` reloads, so a test
  // that left one behind would stop the next one from creating a config at all.
  delete (globalThis as any).__gemiVite;
  vi.spyOn(Bun, "serve").mockImplementation((options: any) => {
    servedOptions.push(options);
    return { port: options.port, stop: vi.fn() } as any;
  });
});

afterEach(() => {
  sockets = null;
  vi.restoreAllMocks();
  delete (globalThis as any).__gemiVite;
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalIdleTimeout === undefined) delete process.env.SERVER_IDLE_TIMEOUT;
  else process.env.SERVER_IDLE_TIMEOUT = originalIdleTimeout;
});

/**
 * #787: the dev server ignored `SERVER_IDLE_TIMEOUT` and ran at Bun's 10s, so a
 * long-poll that worked under `gemi start` was cut under `gemi dev`.
 */
describe("httpDev's idle timeout", () => {
  test("is 10 seconds when SERVER_IDLE_TIMEOUT is unset, as in production", async () => {
    delete process.env.SERVER_IDLE_TIMEOUT;
    await startDev();

    expect(servedOptions[0].idleTimeout).toBe(10);
  });

  test("follows SERVER_IDLE_TIMEOUT", async () => {
    process.env.SERVER_IDLE_TIMEOUT = "60";
    await startDev();

    expect(servedOptions[0].idleTimeout).toBe(60);
  });

  test("keeps the HMR relay on the same server", async () => {
    // The relay's websocket is not subject to `idleTimeout` (see
    // `idleTimeout.test.ts`); this guards that the option was added next to it,
    // not instead of it.
    process.env.SERVER_IDLE_TIMEOUT = "60";
    await startDev();

    expect(servedOptions[0].websocket).toBeDefined();
  });

  test("an invalid value fails the start with the variable's name", async () => {
    process.env.SERVER_IDLE_TIMEOUT = "sixty";

    await expect(startDev()).rejects.toThrow(/SERVER_IDLE_TIMEOUT/);
    // Before Vite was started, so a typo doesn't leave a dev server half up.
    expect(createdConfigs).toHaveLength(0);
  });
});

describe("httpDev's HMR websocket port", () => {
  test("is given to Vite explicitly rather than left to default", async () => {
    delete process.env.PORT;
    await startDev();

    // `server.ws`, not `server.hmr` — the latter is deprecated in Vite 8 and
    // warns on every boot.
    expect(listenHmrServer).toHaveBeenCalledWith(15_173);
    expect(createdConfigs[0].server.ws.server.address().port).toBe(15_173);
    expect(createdConfigs[0].server.hmr).toBeUndefined();
  });

  test("moves with PORT, so a second dev server gets its own socket", async () => {
    // The bug: `PORT` moved the HTTP server and nothing else, so both processes
    // bound 24678 and the second one's pages hot-reloaded on the first one's
    // file changes.
    process.env.PORT = "5174";
    await startDev();

    expect(resolveHmrPort).toHaveBeenCalledWith(5174);
    expect(listenHmrServer).toHaveBeenCalledWith(15_174);
    expect(servedOptions[0].port).toBe(5174);
  });

  test("the HTTP and HMR ports never coincide", async () => {
    process.env.PORT = "5174";
    await startDev();

    expect(createdConfigs[0].server.ws.server.address().port).not.toBe(servedOptions[0].port);
  });

  test("a non-numeric PORT falls back to the default for both ports", async () => {
    process.env.PORT = "not-a-port";
    await startDev();

    expect(servedOptions[0].port).toBe(5173);
    expect(resolveHmrPort).toHaveBeenCalledWith(5173);
  });

  test("stays in middleware mode with the allowed hosts it already had", async () => {
    // Guards the edit itself: the `ws` option was inserted into this object, so
    // check nothing next to it was displaced.
    delete process.env.PORT;
    await startDev();

    expect(createdConfigs[0].server.middlewareMode).toBe(true);
    expect(createdConfigs[0].server.allowedHosts).toBe(true);
    expect(createdConfigs[0].appType).toBe("custom");
  });
});

/**
 * #733: a proxy or tunnel carries only the page's port, so the HMR socket has
 * to be reachable there too. Vite is handed a server (so its client connects
 * to the page's origin) and `Bun.serve` relays that socket to it.
 */
describe("httpDev's HMR websocket behind a proxy", () => {
  test("tells Vite the page's port, and gives it no port of its own to advertise", async () => {
    process.env.PORT = "5174";
    await startDev();

    // Given `ws.server` and no `ws.port`/`clientPort`, Vite's client connects
    // to `location.host`; `server.port` is where its fallback socket goes.
    expect(createdConfigs[0].server.port).toBe(5174);
    expect(createdConfigs[0].server.ws.port).toBeUndefined();
    expect(createdConfigs[0].server.ws.clientPort).toBeUndefined();
  });

  test("relays the Vite client's socket on the page's port to Vite's loopback server", async () => {
    delete process.env.PORT;
    await startDev();
    const { fetch, websocket } = servedOptions[0];
    expect(websocket).toBeDefined();

    const server = { upgrade: vi.fn() };
    const req = new Request("http://tunnel.example/?token=t", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": "vite-hmr" },
    });
    expect(await fetch(req, server)).toBeUndefined();

    expect(upgradeHmr).toHaveBeenCalledWith(req, server, 15_173);
  });

  test("hands every other request, other websockets included, to the app", async () => {
    delete process.env.PORT;
    await startDev();
    const { fetch } = servedOptions[0];
    const upgrade = vi.fn(() => true);

    const page = await fetch(new Request("http://localhost:5173/"), { upgrade });
    expect(upgradeHmr).not.toHaveBeenCalled();
    const otherSocket = await fetch(
      new Request("http://localhost:5173/", {
        headers: { upgrade: "websocket", "sec-websocket-protocol": "chat" },
      }),
      { upgrade },
    );

    expect(await page.text()).toBe("ok");
    expect(await otherSocket.text()).toBe("ok");
    expect(upgrade).not.toHaveBeenCalled();
  });

  test("relays nothing when the app pointed Vite's websocket elsewhere", async () => {
    // An app's `vite.server.ws` in gemi.config.ts is merged over gemi's; with
    // a port and no server, Vite listens there and the client goes direct.
    vi.mocked((await import("vite")).createServer).mockImplementationOnce(async (config: any) => {
      createdConfigs.push(config);
      return {
        ws: { send: vi.fn() },
        middlewares: () => {},
        config: { server: { ws: { port: 30_000 } } },
      } as any;
    });
    delete process.env.PORT;
    await startDev();
    const upgrade = vi.fn(() => true);

    const res = await servedOptions[0].fetch(
      new Request("http://localhost:5173/", {
        headers: { upgrade: "websocket", "sec-websocket-protocol": "vite-hmr" },
      }),
      { upgrade },
    );

    expect(await res.text()).toBe("ok");
    expect(upgradeHmr).not.toHaveBeenCalled();
  });
});

/**
 * The broadcast socket endpoint (#874) shares the dev server's port, and
 * Bun's one `websocket` handler, with the HMR relay.
 */
describe("httpDev's broadcast sockets", () => {
  function fakeTransport() {
    const handler = { open: vi.fn(), message: vi.fn(), close: vi.fn() };
    return {
      handler,
      matches: (req: Request) => new URL(req.url).pathname === "/__gemi/socket",
      upgrade: vi.fn(async () => undefined),
      websocket: handler,
      socketOptions: () => ({ idleTimeout: 120, sendPings: true }),
      start: vi.fn(async () => {}),
      shutdown: vi.fn(),
    };
  }

  test("the endpoint is upgraded by the hub, and HMR is still relayed", async () => {
    delete process.env.PORT;
    sockets = fakeTransport();
    await startDev();
    const { fetch, websocket, idleTimeout } = servedOptions[0];
    const server = { upgrade: vi.fn() };

    const socketReq = new Request("http://localhost:5173/__gemi/socket", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": "gemi.v1" },
    });
    expect(await fetch(socketReq, server)).toBeUndefined();
    expect(sockets.upgrade).toHaveBeenCalledWith(socketReq, server);
    expect(sockets.start).toHaveBeenCalledTimes(1);

    const hmrReq = new Request("http://localhost:5173/", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": "vite-hmr" },
    });
    await fetch(hmrReq, server);
    expect(upgradeHmr).toHaveBeenCalledWith(hmrReq, server, 15_173);

    // The HTTP idle timeout is untouched; the socket settings are the hub's.
    expect(idleTimeout).toBe(10);
    expect(websocket.sendPings).toBe(true);
  });

  test("each socket goes to its own handler", async () => {
    delete process.env.PORT;
    sockets = fakeTransport();
    await startDev();
    const { websocket } = servedOptions[0];

    const broadcastSocket = { data: { gemiSocket: true } } as any;
    websocket.open(broadcastSocket);
    websocket.message(broadcastSocket, '{"op":"ping"}');
    websocket.close(broadcastSocket, 1000, "");
    expect(sockets.handler.open).toHaveBeenCalledWith(broadcastSocket);
    expect(sockets.handler.message).toHaveBeenCalledWith(broadcastSocket, '{"op":"ping"}');
    expect(sockets.handler.close).toHaveBeenCalledWith(broadcastSocket, 1000, "");

    // An HMR relay socket: its upstream is already closed, so the relay's own
    // `open` closes the browser's side, which the hub never sees.
    const close = vi.fn();
    const hmrSocket = {
      data: { upstream: { readyState: 3, close: vi.fn() }, early: [] },
      close,
      send: vi.fn(),
    } as any;
    websocket.open(hmrSocket);
    expect(close).toHaveBeenCalledWith(1000);
    expect(sockets.handler.open).toHaveBeenCalledTimes(1);
  });
});
