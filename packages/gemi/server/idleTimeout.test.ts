import { describe, expect, test } from "vitest";

import { DEFAULT_SERVER_IDLE_TIMEOUT, serverIdleTimeout } from "./idleTimeout";

describe("serverIdleTimeout", () => {
  test("is Bun's 10 seconds when SERVER_IDLE_TIMEOUT is unset or blank", () => {
    expect(DEFAULT_SERVER_IDLE_TIMEOUT).toBe(10);
    expect(serverIdleTimeout(undefined)).toBe(10);
    expect(serverIdleTimeout("")).toBe(10);
    expect(serverIdleTimeout("  ")).toBe(10);
  });

  test("reads whole seconds, 0 (disabled) to 255 included", () => {
    expect(serverIdleTimeout("60")).toBe(60);
    expect(serverIdleTimeout(" 60 ")).toBe(60);
    expect(serverIdleTimeout("0")).toBe(0);
    expect(serverIdleTimeout("255")).toBe(255);
  });

  test.each(["abc", "1.5", "-1", "256", "60s"])("refuses %j, naming the variable", (raw) => {
    expect(() => serverIdleTimeout(raw)).toThrow(/SERVER_IDLE_TIMEOUT/);
  });

  test("reads process.env when given nothing", () => {
    const before = process.env.SERVER_IDLE_TIMEOUT;
    try {
      process.env.SERVER_IDLE_TIMEOUT = "42";
      expect(serverIdleTimeout()).toBe(42);
    } finally {
      if (before === undefined) delete process.env.SERVER_IDLE_TIMEOUT;
      else process.env.SERVER_IDLE_TIMEOUT = before;
    }
  });
});

/**
 * #787 raised the dev server's `idleTimeout` from Bun's default to whatever the
 * app sets, and the dev server also carries the HMR websocket relay. This pins
 * the Bun behaviour that makes that safe in both directions: the server-level
 * `idleTimeout` does not reach an upgraded websocket, so a short value can't
 * cut the HMR socket and a long one doesn't change it. Bun checks timeouts on
 * a ~4s tick, hence the wait.
 */
test("an upgraded websocket outlives the server's idleTimeout", async () => {
  const server = Bun.serve({
    port: 0,
    idleTimeout: serverIdleTimeout("1"),
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: { message() {} },
  });
  try {
    const ws = new WebSocket(`ws://localhost:${server.port}`);
    let closed = false;
    ws.addEventListener("close", () => {
      closed = true;
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });

    await Bun.sleep(5_500);
    expect(closed).toBe(false);
    ws.close();
  } finally {
    server.stop(true);
  }
}, 15_000);
