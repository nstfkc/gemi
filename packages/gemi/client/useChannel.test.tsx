/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";

import { fakeSocket, type FakeSocket } from "../testing";
import { Page } from "../testing/Page";
import { useChannel, useChannelInvalidate } from "./useChannel";
import { useQuery } from "./useQuery";

/** A `fetch` that answers every request at once with `body(url)`. */
function stubFetch(body: (url: string) => unknown) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => body(String(url)),
    headers: new Headers(),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof stubFetch>, path: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`/api${path}`)).length;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useChannel", () => {
  test("on handlers get events, onResync the resyncs, and status follows the socket", () => {
    const socket: FakeSocket = fakeSocket();
    const events: unknown[] = [];
    let resyncs = 0;
    function View() {
      const { status, code } = useChannel(
        "site.:siteId" as any,
        { params: { siteId: "abc" } },
        { on: { changed: (d: unknown) => events.push(d) }, onResync: () => resyncs++ },
      );
      return <p>{`${status}${code ? `:${code}` : ""}`}</p>;
    }
    render(
      <Page socket={socket}>
        <View />
      </Page>,
    );
    expect(screen.getByText("open")).toBeDefined();
    expect(socket.subscriptions).toEqual([
      { pattern: "site.:siteId", params: { siteId: "abc" }, status: "open", code: null },
    ]);

    act(() => socket.emit("site.:siteId", "changed", { pages: ["/about"] }));
    act(() => socket.emit("site.abc", "changed", { pages: ["/"] }));
    act(() => socket.emit("site.other", "changed", { pages: ["/x"] }));
    act(() => socket.emit("site.abc", "unknown"));
    expect(events).toEqual([{ pages: ["/about"] }, { pages: ["/"] }]);

    act(() => socket.resync());
    expect(resyncs).toBe(1);

    act(() => socket.deny("site.:siteId", "denied"));
    expect(screen.getByText("denied:denied")).toBeDefined();
    act(() => socket.setStatus("closed"));
    expect(screen.getByText("closed")).toBeDefined();
  });

  test("unmounting releases the subscription; enabled: false never subscribes", () => {
    const socket = fakeSocket();
    function View({ enabled }: { enabled: boolean }) {
      const { status } = useChannel("status" as any, {}, { enabled });
      return <p>{status}</p>;
    }
    const { rerender, unmount } = render(
      <Page socket={socket}>
        <View enabled={false} />
      </Page>,
    );
    expect(screen.getByText("idle")).toBeDefined();
    expect(socket.subscriptions).toHaveLength(0);
    rerender(
      <Page socket={socket}>
        <View enabled />
      </Page>,
    );
    expect(socket.subscriptions).toHaveLength(1);
    unmount();
    expect(socket.subscriptions).toHaveLength(0);
  });

  test("warns once in development about on without onResync", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    function View() {
      useChannel("warned.channel" as any, {}, { on: { x: () => {} } });
      return null;
    }
    render(
      <Page>
        <View />
        <View />
      </Page>,
    );
    const ours = warn.mock.calls.filter(([m]) => String(m).includes('useChannel("warned.channel")'));
    expect(ours).toHaveLength(1);
  });

  test("the user channel matches any user.<id> topic", () => {
    const socket = fakeSocket();
    const got: unknown[] = [];
    function View() {
      useChannel("user" as any, {}, { on: { credits: (d: unknown) => got.push(d) }, onResync() {} });
      return null;
    }
    render(
      <Page socket={socket}>
        <View />
      </Page>,
    );
    act(() => socket.emit("user.7", "credits", { balance: 3 }));
    expect(got).toEqual([{ balance: 3 }]);
  });
});

describe("useChannelInvalidate", () => {
  test("an event or a resync refetches the rendered variants of each path", async () => {
    const socket = fakeSocket();
    let version = 0;
    const fetchMock = stubFetch(() => ({ version }));
    function View() {
      useChannelInvalidate("page.:pageId" as any, { pageId: "p1" }, [
        "/pages/:pageId" as any,
        { path: "/other" as any },
      ]);
      const { data } = useQuery("/pages/:pageId" as any, { params: { pageId: "p1" } });
      return <p>{`v${(data as { version: number }).version}`}</p>;
    }
    render(
      <Page socket={socket} queryData={{ "/pages/p1": { version: 0 } }}>
        <View />
      </Page>,
    );
    expect(screen.getByText("v0")).toBeDefined();
    expect(calls(fetchMock, "/pages/p1")).toBe(0);

    version = 1;
    await act(async () => socket.emit("page.p1", "changed"));
    expect(await screen.findByText("v1")).toBeDefined();
    expect(calls(fetchMock, "/pages/p1")).toBe(1);
    // Not rendered: nothing to refetch.
    expect(calls(fetchMock, "/other")).toBe(0);

    version = 2;
    await act(async () => socket.resync());
    expect(await screen.findByText("v2")).toBeDefined();
    expect(calls(fetchMock, "/pages/p1")).toBe(2);
  });

  test("a burst of events refetches once per 150 ms window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const socket = fakeSocket();
    const fetchMock = stubFetch(() => ({ version: 1 }));
    function View() {
      useChannelInvalidate("page.:pageId" as any, { pageId: "p1" }, ["/pages/:pageId" as any]);
      useQuery("/pages/:pageId" as any, { params: { pageId: "p1" } });
      return null;
    }
    render(
      <Page socket={socket} queryData={{ "/pages/p1": { version: 0 } }}>
        <View />
      </Page>,
    );
    for (let i = 0; i < 20; i++) {
      await act(async () => socket.emit("page.p1", "progress", { i }));
    }
    expect(calls(fetchMock, "/pages/p1")).toBe(0);
    await act(async () => vi.advanceTimersByTime(150));
    expect(calls(fetchMock, "/pages/p1")).toBe(1);
    // A steady stream still refetches, once per window.
    for (let i = 0; i < 3; i++) {
      await act(async () => socket.emit("page.p1", "progress", { i }));
      await act(async () => vi.advanceTimersByTime(150));
    }
    expect(calls(fetchMock, "/pages/p1")).toBe(4);
  });
});

describe("useQuery({ live })", () => {
  test("a burst of events refetches once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const socket = fakeSocket();
    const fetchMock = stubFetch(() => ({ n: 1 }));
    function View() {
      useQuery("/imports/:id" as any, { params: { id: "i1" } }, { live: "user" as any });
      return null;
    }
    render(
      <Page socket={socket} queryData={{ "/imports/i1": { n: 0 } }}>
        <View />
      </Page>,
    );
    for (let i = 0; i < 10; i++) {
      await act(async () => socket.emit("user.1", "import", { i }));
    }
    await act(async () => vi.advanceTimersByTime(150));
    expect(calls(fetchMock, "/imports/i1")).toBe(1);
  });

  test("refetchUntil pauses while the channel is open and resumes as the fallback", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const socket = fakeSocket();
    let n = 0;
    const fetchMock = stubFetch(() => ({ n: ++n }));
    function View() {
      const { data } = useQuery(
        "/imports/:id" as any,
        { params: { id: "i1" } },
        { refetchUntil: () => 1_000, live: "user" as any },
      );
      return <p>{`n${(data as { n: number }).n}`}</p>;
    }
    render(
      <Page socket={socket} queryData={{ "/imports/i1": { n: 0 } }}>
        <View />
      </Page>,
    );
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(calls(fetchMock, "/imports/i1")).toBe(0);

    // An event refetches.
    await act(async () => socket.emit("user.1", "import", { id: "i1" }));
    await act(async () => vi.advanceTimersByTime(150));
    expect(calls(fetchMock, "/imports/i1")).toBe(1);

    // Live delivery down: polling takes over.
    await act(async () => socket.setStatus("closed"));
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(calls(fetchMock, "/imports/i1")).toBe(2);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(calls(fetchMock, "/imports/i1")).toBe(3);

    // Back up: polling pauses again.
    await act(async () => socket.setStatus("open"));
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(calls(fetchMock, "/imports/i1")).toBe(3);
  });
});
