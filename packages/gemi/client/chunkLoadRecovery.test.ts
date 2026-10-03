/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CHUNK_RELOAD_MARKER,
  __resetChunkLoadRecovery,
  chunkReloadStubScript,
  configureChunkLoadRecovery,
  isChunkLoadError,
  recoverFromChunkLoadError,
} from "./chunkLoadRecovery";
import { loadViewModule } from "./ComponentContext";

/**
 * A chunk that will not load gets one full reload onto the page being
 * navigated to — and never a second one inside the cooldown, which is what
 * keeps a chunk that is really gone from reloading the tab forever.
 */

const chunkError = () =>
  new TypeError("Failed to fetch dynamically imported module: https://app.test/assets/Home-x.js");

let reload: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;
const realLocation = window.location;

beforeEach(() => {
  reload = vi.fn();
  assign = vi.fn();
  // jsdom's `location.reload` is not configurable; replace the object.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "https://app.test/dashboard", reload, assign },
  });
  window.sessionStorage.clear();
  __resetChunkLoadRecovery();
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (window as any).loaders;
});

describe("isChunkLoadError", () => {
  test.each([
    ["Chromium", "Failed to fetch dynamically imported module: https://a/assets/x.js"],
    ["Firefox", "error loading dynamically imported module: https://a/assets/x.js"],
    ["Safari", "Importing a module script failed."],
    ["iOS 16 Safari", "Importing module './imageUrl-DtezMpO4.js' is not found."],
    ["Vite's preload helper", "Unable to preload CSS for /assets/x.css"],
  ])("recognises %s's wording", (_engine, message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  test("a view that loaded and threw is not one", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("recoverFromChunkLoadError", () => {
  test("reloads once and records when", () => {
    expect(recoverFromChunkLoadError(chunkError(), { source: "navigation" })).toBe(true);

    expect(reload).toHaveBeenCalledTimes(1);
    const marker = JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)!);
    expect(marker.url).toBe("https://app.test/dashboard");
    expect(typeof marker.at).toBe("number");
  });

  test("goes to the URL it is given when that is not the current one", () => {
    recoverFromChunkLoadError(chunkError(), { url: "https://app.test/settings" });

    expect(assign).toHaveBeenCalledWith("https://app.test/settings");
    expect(reload).not.toHaveBeenCalled();
  });

  test("does not reload again inside the cooldown, and does after it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER,
      JSON.stringify({ url: "https://app.test/dashboard", at: Date.now() - 5_000 }),
    );

    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 30_000);
    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a marker from the future (clock set back) does not block recovery for good", () => {
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER,
      JSON.stringify({ url: "https://app.test/dashboard", at: Date.now() + 86_400_000 }),
    );

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a route failing once per view reloads once", () => {
    recoverFromChunkLoadError(chunkError());
    recoverFromChunkLoadError(chunkError());

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("does not reload when sessionStorage is unusable, since nothing would stop a loop", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const onChunkLoadError = vi.fn();
    configureChunkLoadRecovery({ onChunkLoadError });

    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(onChunkLoadError).toHaveBeenCalledWith(expect.objectContaining({ blocked: "storage" }));
  });

  test("does not reload offline", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  test("ignores errors that are not chunk failures", () => {
    expect(recoverFromChunkLoadError(new Error("boom"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)).toBeNull();
  });

  test("the app's hook sees the failure and can veto the reload", () => {
    const onChunkLoadError = vi.fn(() => false);
    configureChunkLoadRecovery({ onChunkLoadError });
    const error = chunkError();

    expect(recoverFromChunkLoadError(error, { source: "preload" })).toBe(false);
    expect(onChunkLoadError).toHaveBeenCalledWith({
      error,
      url: "https://app.test/dashboard",
      source: "preload",
      blocked: null,
    });
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)).toBeNull();
  });

  test("the cooldown is configurable", () => {
    configureChunkLoadRecovery({ cooldownMs: 1_000 });
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER,
      JSON.stringify({ url: "x", at: Date.now() - 2_000 }),
    );

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
  });

  test("`false` turns recovery off", () => {
    configureChunkLoadRecovery(false);

    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("loadViewModule", () => {
  test("a navigation whose view chunk fails reloads, and still rejects", async () => {
    const error = chunkError();
    (window as any).loaders = { Home: () => Promise.reject(error) };

    await expect(loadViewModule("Home")).rejects.toBe(error);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a prefetch that fails does not reload", async () => {
    (window as any).loaders = { Home: () => Promise.reject(chunkError()) };

    await expect(loadViewModule("Home", "prefetch")).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  test("a view that throws while evaluating does not reload", async () => {
    (window as any).loaders = {
      Home: () => Promise.reject(new ReferenceError("x is not defined")),
    };

    await expect(loadViewModule("Home")).rejects.toThrow("x is not defined");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("the server's reload stub", () => {
  // The stub is a module body; evaluate it as a function body without the
  // trailing `export {}`, which is all that makes it a module.
  const run = (pathname = "/assets/Home-x.js") =>
    new Function(chunkReloadStubScript(pathname).replace(/export \{\}$/, ""))();

  test("reloads and leaves the marker the client guard reads", () => {
    run();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)!).at).toEqual(
      expect.any(Number),
    );
  });

  test("inside the cooldown it throws a chunk-load error instead of reloading again", () => {
    recoverFromChunkLoadError(chunkError());
    reload.mockClear();

    let thrown: unknown;
    try {
      run("/assets/Home-x.js");
    } catch (error) {
      thrown = error;
    }
    expect(reload).not.toHaveBeenCalled();
    expect(isChunkLoadError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("/assets/Home-x.js");
  });

  test("without storage it throws rather than reloading unguarded", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(() => run()).toThrow(/Failed to fetch dynamically imported module/);
    expect(reload).not.toHaveBeenCalled();
  });
});
