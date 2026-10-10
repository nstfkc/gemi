/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react";

import { Page } from "../../testing/Page";
import { usePost } from "../useMutation";
import { getRealtimeClient } from "./RealtimeClient";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a mutation carries X-Gemi-Socket while the tab's socket is open", async () => {
  const sockets: any[] = [];
  class MockSocket {
    readyState = 0;
    onopen: any;
    onmessage: any;
    onclose: any;
    send() {}
    close() {}
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", MockSocket);
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => usePost("/save" as any), { wrapper: Page });
  await act(async () => {
    await (result.current as any).trigger({ a: 1 });
  });
  expect((fetchMock.mock.calls[0] as any)[1].headers["x-gemi-socket"]).toBeUndefined();

  const release = getRealtimeClient()!.subscribe("status", {}, {});
  sockets[0].readyState = 1;
  sockets[0].onopen();
  sockets[0].onmessage({
    data: JSON.stringify({ op: "hello", socketId: "sock_abcdefgh12", tag: "t", heartbeatMs: 25_000 }),
  });
  await act(async () => {
    await (result.current as any).trigger({ a: 1 });
  });
  expect((fetchMock.mock.calls[1] as any)[1].headers["x-gemi-socket"]).toBe("sock_abcdefgh12");
  release();
  (getRealtimeClient() as any).dispose();
});
