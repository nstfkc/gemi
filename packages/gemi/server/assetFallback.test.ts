import { describe, expect, test, vi } from "vitest";
import {
  ASSET_FALLBACK_HEADER,
  assetFallbackBase,
  createAssetFallback,
} from "./assetFallback";

const BASE = "https://store.test/web/";
const get = (path: string, method = "GET") => new Request(`https://app.test${path}`, { method });

function upstream(body: string | null, init: ResponseInit = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, init));
}

describe("assetFallbackBase", () => {
  test("unset or blank is no fallback", () => {
    expect(assetFallbackBase(undefined)).toBeUndefined();
    expect(assetFallbackBase("  ")).toBeUndefined();
  });

  test("an absolute http(s) URL gets a trailing slash", () => {
    expect(assetFallbackBase("https://store.test/web")).toBe("https://store.test/web/");
    expect(assetFallbackBase("https://store.test/web/")).toBe("https://store.test/web/");
  });

  test("anything else is reported and ignored rather than failing the boot", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(assetFallbackBase("/assets-store/")).toBeUndefined();
    expect(assetFallbackBase("ftp://store.test/")).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe("createAssetFallback", () => {
  test("streams the store's file back as an immutable asset of the right type", async () => {
    const fetch = upstream("export const a = 1;", {
      headers: { "content-type": "application/octet-stream", "content-length": "19" },
    });
    const fallback = createAssetFallback({ base: BASE, fetch });

    const response = await fallback(get("/assets/Home-abc.js"), "/assets/Home-abc.js");

    expect(fetch).toHaveBeenCalledWith(
      "https://store.test/web/assets/Home-abc.js",
      expect.objectContaining({ method: "GET" }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("export const a = 1;");
    // The extension wins over a store's generic label: a module script
    // served as octet-stream is refused by the browser.
    expect(response?.headers.get("content-type")).toMatch(/javascript/);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response?.headers.get("content-length")).toBe("19");
    expect(response?.headers.get(ASSET_FALLBACK_HEADER)).toBe("1");
  });

  test("a store's type is kept for an extension the server does not know", async () => {
    const fetch = upstream("x", { headers: { "content-type": "application/x-thing" } });
    const fallback = createAssetFallback({ base: BASE, fetch });

    const response = await fallback(get("/assets/blob-abc.unknownext"), "/assets/blob-abc.unknownext");

    expect(response?.headers.get("content-type")).toBe("application/x-thing");
  });

  test("an encoded answer drops the length, which no longer holds once fetch decodes it", async () => {
    const fetch = upstream("body", {
      headers: { "content-length": "3", "content-encoding": "gzip" },
    });
    const fallback = createAssetFallback({ base: BASE, fetch });

    const response = await fallback(get("/assets/a.css"), "/assets/a.css");

    expect(response?.headers.get("content-length")).toBeNull();
  });

  test("HEAD gets the headers without a body", async () => {
    const fetch = upstream(null, { headers: { "content-type": "text/css" } });
    const fallback = createAssetFallback({ base: BASE, fetch });

    const response = await fallback(get("/assets/a.css", "HEAD"), "/assets/a.css");

    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "HEAD" });
    expect(response?.status).toBe(200);
    expect(response?.body).toBeNull();
  });

  test("other methods are never forwarded", async () => {
    const fetch = upstream("x");
    const fallback = createAssetFallback({ base: BASE, fetch });

    expect(await fallback(get("/assets/a.js", "POST"), "/assets/a.js")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a miss in the store is answered locally and not asked for again inside the window", async () => {
    let clock = 1_000;
    const fetch = upstream("missing", { status: 404 });
    const fallback = createAssetFallback({ base: BASE, fetch, missTtlMs: 30_000, now: () => clock });

    expect(await fallback(get("/assets/gone.js"), "/assets/gone.js")).toBeUndefined();
    expect(await fallback(get("/assets/gone.js"), "/assets/gone.js")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);

    clock += 30_000;
    expect(await fallback(get("/assets/gone.js"), "/assets/gone.js")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("a store that errors or does not answer in time is a miss", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    expect(
      await createAssetFallback({ base: BASE, fetch: failing as never })(get("/assets/a.js"), "/assets/a.js"),
    ).toBeUndefined();

    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const fallback = createAssetFallback({ base: BASE, fetch: hanging as never, timeoutMs: 10 });
    expect(await fallback(get("/assets/slow.js"), "/assets/slow.js")).toBeUndefined();
  });

  test("a path cannot climb out of the base", async () => {
    const fetch = upstream("x");
    const fallback = createAssetFallback({ base: BASE, fetch });

    expect(await fallback(get("/x"), "/../../secret.js")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
