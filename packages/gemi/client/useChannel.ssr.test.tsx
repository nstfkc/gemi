/** @vitest-environment node */
import { describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";

import { QueryManagerProvider } from "./QueryManagerContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { currentSocketId, getRealtimeClient } from "./realtime/RealtimeClient";
import { useChannel, useChannelInvalidate } from "./useChannel";
import { useQuery } from "./useQuery";

describe("channel hooks on the server", () => {
  test("report closed and open no socket", () => {
    const WebSocketSpy = vi.fn();
    vi.stubGlobal("WebSocket", WebSocketSpy);
    function View() {
      const a = useChannel("site.:siteId" as any, { params: { siteId: "abc" } }, { onResync() {} });
      const b = useChannelInvalidate("user" as any, undefined, ["/me" as any]);
      const { data } = useQuery("/me" as any, {}, { live: "user" as any });
      return <p>{`${a.status}/${b.status}/${(data as { ok: boolean }).ok}`}</p>;
    }
    const html = renderToString(
      <QueryManagerProvider>
        <RouteStateProvider
          state={{ prefetchedData: { "/me": { "": { ok: true } } } } as unknown as RouteState & PageData}
        >
          <View />
        </RouteStateProvider>
      </QueryManagerProvider>,
    );
    expect(html).toContain("closed/closed/true");
    expect(WebSocketSpy).not.toHaveBeenCalled();
    expect(getRealtimeClient()).toBeNull();
    expect(currentSocketId()).toBeNull();
    vi.unstubAllGlobals();
  });
});
