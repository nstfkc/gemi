/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";

// The socket module is loaded by the first subscription, not by importing
// `gemi/client` (#891). These run against the tab's real client, through a
// stubbed WebSocket, with no socket provided by `<Page>`. Each test imports
// the hooks afresh: the tab's client is a module-level singleton, and a test
// that finds it already loaded would not exercise the load.
let loader: typeof import("./loader");
let useChannel: typeof import("../useChannel").useChannel;

beforeEach(async () => {
  vi.resetModules();
  loader = await import("./loader");
  ({ useChannel } = await import("../useChannel"));
});

class MockSocket {
  static instances: MockSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    MockSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

afterEach(() => {
  cleanup();
  loader.loadedRealtimeClient()?.dispose();
  vi.unstubAllGlobals();
  MockSocket.instances = [];
});

test("the first subscription loads the client, connects and receives events", async () => {
  vi.stubGlobal("WebSocket", MockSocket);
  loader.configureRealtime({ path: "/custom/socket" });
  // Importing the hooks loads nothing: no client until something subscribes.
  expect(loader.loadedRealtimeClient()).toBeNull();
  expect(loader.currentSocketId()).toBeNull();

  const events: unknown[] = [];
  let resyncs = 0;
  function View() {
    const { status } = useChannel(
      "site.:siteId" as any,
      { params: { siteId: "abc" } },
      { on: { changed: (d: unknown) => events.push(d) }, onResync: () => resyncs++ },
    );
    return <p>{status}</p>;
  }
  render(<View />);
  // The module is still loading: the hook reports `closed`.
  expect(screen.getByText("closed")).toBeDefined();

  await act(async () => {
    await vi.waitFor(() => expect(MockSocket.instances).toHaveLength(1));
  });
  const ws = MockSocket.instances[0]!;
  expect(loader.loadedRealtimeClient()).not.toBeNull();
  expect(ws.url).toBe("ws://localhost:3000/custom/socket");
  expect(ws.protocols).toEqual(["gemi.v1"]);
  expect(screen.getByText("connecting")).toBeDefined();

  act(() => {
    ws.readyState = 1;
    ws.onopen?.();
    ws.receive({ op: "hello", socketId: "sock_abcdefgh12", tag: "t1", heartbeatMs: 25_000 });
  });
  expect(ws.sent).toEqual([{ op: "sub", id: "1", ch: "site.:siteId", p: { siteId: "abc" } }]);
  expect(loader.currentSocketId()).toBe("sock_abcdefgh12");

  act(() => ws.receive({ op: "subscribed", id: "1", t: "site.abc" }));
  expect(screen.getByText("open")).toBeDefined();
  expect(resyncs).toBe(1);

  act(() => ws.receive({ op: "ev", t: "site.abc", ev: "changed", d: { pages: ["/"] } }));
  expect(events).toEqual([{ pages: ["/"] }]);
});

test("a hook unmounted while the client loads never subscribes", async () => {
  vi.stubGlobal("WebSocket", MockSocket);
  function View() {
    return <p>{useChannel("user" as any, {}, { onResync() {} }).status}</p>;
  }
  const view = render(<View />);
  view.unmount();
  // Let the load settle, if it was still pending.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(MockSocket.instances).toHaveLength(0);
});
