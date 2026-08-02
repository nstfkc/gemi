import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { loadRoutePayload } from "./loadRoutePayload";
import { PARTIAL_RENDER_HEADER } from "../../utils/partialRender";

let fetchMock: ReturnType<typeof vi.fn>;

/** Responds to every request with `body`, unless `ok` says otherwise. */
function stubFetch(body: any, ok = true) {
  fetchMock = vi.fn(async () => ({ ok, json: async () => body }) as Response);
  (globalThis as any).fetch = fetchMock;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).fetch;
});

const RENDERED = "/current";

describe("a prefetched payload", () => {
  test("is committed without issuing a request", async () => {
    stubFetch({ data: { fetched: true } });
    const warmed = { data: { prefetched: true } };

    const payload = await loadRoutePayload({
      url: "/next.json",
      from: RENDERED,
      takePrefetched: () => Promise.resolve(warmed),
      renderedRoute: () => RENDERED,
    });

    expect(payload).toBe(warmed);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("is taken from the URL the navigation asks for", async () => {
    stubFetch({ data: {} });
    const takePrefetched = vi.fn(() => null);

    await loadRoutePayload({
      url: "/next.json?page=2",
      from: RENDERED,
      takePrefetched,
      renderedRoute: () => RENDERED,
    });

    expect(takePrefetched).toHaveBeenCalledWith("/next.json?page=2");
  });
});

describe("falling through to a request", () => {
  test("happens when nothing was prefetched", async () => {
    const fetched = { data: { fetched: true } };
    stubFetch(fetched);

    const payload = await loadRoutePayload({
      url: "/next.json",
      from: RENDERED,
      takePrefetched: () => null,
      renderedRoute: () => RENDERED,
    });

    expect(payload).toBe(fetched);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("happens when the prefetch failed", async () => {
    const fetched = { data: { fetched: true } };
    stubFetch(fetched);

    const payload = await loadRoutePayload({
      url: "/next.json",
      from: RENDERED,
      // What `PrefetchCache.take` resolves to for a load that never landed.
      takePrefetched: () => Promise.resolve(null),
      renderedRoute: () => RENDERED,
    });

    expect(payload).toBe(fetched);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("sends the partial-render header", async () => {
    stubFetch({ data: {} });

    await loadRoutePayload({
      url: "/next.json",
      from: "/current?tab=2",
      renderedRoute: () => RENDERED,
    });

    expect(fetchMock).toHaveBeenCalledWith("/next.json", {
      headers: { [PARTIAL_RENDER_HEADER]: "/current?tab=2" },
    });
  });

  test("returns null on a failed response", async () => {
    stubFetch({ data: {} }, false);

    await expect(
      loadRoutePayload({
        url: "/next.json",
        from: RENDERED,
        renderedRoute: () => RENDERED,
      }),
    ).resolves.toBeNull();
  });

  test("returns null when the request throws", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    (globalThis as any).fetch = fetchMock;

    await expect(
      loadRoutePayload({
        url: "/next.json",
        from: RENDERED,
        renderedRoute: () => RENDERED,
      }),
    ).resolves.toBeNull();
  });
});

describe("a partial response computed against a stale base", () => {
  test("is re-requested in full", async () => {
    const partial = { data: { partial: true }, partial: { from: "/old" } };
    const full = { data: { full: true } };
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => partial })
      .mockResolvedValueOnce({ ok: true, json: async () => full });
    (globalThis as any).fetch = fetchMock;

    const payload = await loadRoutePayload({
      url: "/next.json",
      from: "/old",
      // A navigation committed while this one was in flight.
      renderedRoute: () => "/somewhere-else",
    });

    expect(payload).toBe(full);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual(["/next.json"]);
  });

  test("is kept when the base still matches", async () => {
    const partial = { data: {}, partial: { from: RENDERED } };
    stubFetch(partial);

    const payload = await loadRoutePayload({
      url: "/next.json",
      from: RENDERED,
      renderedRoute: () => RENDERED,
    });

    expect(payload).toBe(partial);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
