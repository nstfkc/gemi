/** @vitest-environment jsdom */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CHUNK_RELOAD_MARKER,
  __resetChunkLoadRecovery,
  chunkReloadStubScript,
  configureChunkLoadRecovery,
  isChunkLoadError,
  navigationStarted,
  otherBuild,
  recoverFromBuildMismatch,
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
  window.name = "";
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
    expect(marker).toEqual({ "https://app.test/dashboard": expect.any(Number) });
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
      JSON.stringify({ "https://app.test/dashboard": Date.now() - 5_000 }),
    );

    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 30_000);
    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("the cooldown is per URL: another page inside it still reloads (#1056)", () => {
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER,
      JSON.stringify({ "https://app.test/settings": Date.now() - 5_000 }),
    );

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)!))).toEqual([
      "https://app.test/settings",
      "https://app.test/dashboard",
    ]);
  });

  test("entries past the cooldown are dropped when a reload is recorded", () => {
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER,
      JSON.stringify({ "https://app.test/settings": Date.now() - 60_000 }),
    );

    recoverFromChunkLoadError(chunkError());

    expect(Object.keys(JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)!))).toEqual([
      "https://app.test/dashboard",
    ]);
  });

  test("a marker in the earlier `{ url, at }` shape is ignored", () => {
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER,
      JSON.stringify({ url: "https://app.test/dashboard", at: Date.now() }),
    );

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
  });

  test("a marker from the future (clock set back) does not block recovery for good", () => {
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER,
      JSON.stringify({ "https://app.test/dashboard": Date.now() + 86_400_000 }),
    );

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a route failing once per view reloads once", () => {
    recoverFromChunkLoadError(chunkError());
    recoverFromChunkLoadError(chunkError());

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("does not reload when no marker can be kept, since nothing would stop a loop", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    window.name = "a name of the app's own";
    const onChunkLoadError = vi.fn();
    configureChunkLoadRecovery({ onChunkLoadError });

    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(onChunkLoadError).toHaveBeenCalledWith(expect.objectContaining({ blocked: "storage" }));
    expect(window.name).toBe("a name of the app's own");
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
      JSON.stringify({ "https://app.test/dashboard": Date.now() - 2_000 }),
    );

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
  });

  test("`false` turns recovery off", () => {
    configureChunkLoadRecovery(false);

    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("recoverFromBuildMismatch (#1056)", () => {
  const mismatch = (url = "https://app.test/dashboard") =>
    recoverFromBuildMismatch({ url, clientBuild: "a", serverBuild: "b" });

  test("loads the page in full once, under the chunk guard", () => {
    expect(mismatch()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    __resetChunkLoadRecovery();
    expect(mismatch(), "same URL inside the cooldown").toBe(false);
    expect(mismatch("https://app.test/settings")).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://app.test/settings");
  });

  // folio#2750: the load was cancelled ("Stay" on a dirty page's
  // `beforeunload` prompt; here `assign`/`reload` do nothing) and the page
  // keeps running. Nothing may stay latched behind it.
  test("a cancelled load does not hold back another URL", () => {
    expect(mismatch()).toBe(true);
    expect(mismatch(), "same navigation, load still pending").toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(mismatch("https://app.test/settings")).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://app.test/settings");
  });

  test("a cancelled load is retried for the same URL after the cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    expect(mismatch()).toBe(true);

    vi.setSystemTime(Date.now() + 30_000);
    expect(mismatch()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test("a new navigation after a cancelled load is not discarded inside the cooldown", () => {
    expect(mismatch()).toBe(true);

    navigationStarted();
    // Refused by the cooldown, so the caller renders the data instead of
    // waiting on a load that is not coming.
    expect(mismatch()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a load the app's hook vetoed latches nothing", () => {
    const onBuildMismatch = vi.fn(() => false);
    configureChunkLoadRecovery({ onBuildMismatch });
    expect(mismatch()).toBe(false);

    onBuildMismatch.mockReturnValue(undefined as never);
    expect(mismatch("https://app.test/settings")).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://app.test/settings");
  });

  test("the app's hook sees it and can veto the load", () => {
    const onBuildMismatch = vi.fn(() => false);
    configureChunkLoadRecovery({ onBuildMismatch });

    expect(mismatch()).toBe(false);
    expect(onBuildMismatch).toHaveBeenCalledWith({
      url: "https://app.test/dashboard",
      clientBuild: "a",
      serverBuild: "b",
      blocked: null,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  test("`chunkLoadRecovery: false` turns it off too", () => {
    configureChunkLoadRecovery(false);

    expect(mismatch()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  test("otherBuild compares only when both sides know their build", () => {
    const response = (build?: string) =>
      new Response("{}", { headers: build ? { "x-gemi-build": build } : {} });

    expect(otherBuild(response("b"), "a")).toBe("b");
    expect(otherBuild(response("a"), "a")).toBeNull();
    expect(otherBuild(response(), "a")).toBeNull();
    expect(otherBuild(response("b"), undefined)).toBeNull();
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
    expect(JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)!)).toEqual({
      "https://app.test/dashboard": expect.any(Number),
    });
  });

  test("inside another page's cooldown it still reloads, keeping that entry", () => {
    recoverFromChunkLoadError(chunkError(), { url: "https://app.test/settings" });
    reload.mockClear();

    run();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)!))).toEqual([
      "https://app.test/settings",
      "https://app.test/dashboard",
    ]);
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
    window.name = "a name of the app's own";

    expect(() => run()).toThrow(/Failed to fetch dynamically imported module/);
    expect(reload).not.toHaveBeenCalled();
    expect(window.name).toBe("a name of the app's own");
  });

  test("without sessionStorage it reloads once under the window.name marker, shared with the client", () => {
    blockSessionStorage("getter");

    run();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.name.startsWith(`${CHUNK_RELOAD_MARKER}:`)).toBe(true);

    // The reloaded document: the client's recovery for the same page is refused…
    reload.mockClear();
    __resetChunkLoadRecovery();
    const onChunkLoadError = vi.fn();
    configureChunkLoadRecovery({ onChunkLoadError });
    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(onChunkLoadError).toHaveBeenCalledWith(expect.objectContaining({ blocked: "cooldown" }));
    // …and so is the stub's.
    expect(() => run()).toThrow(/Failed to fetch dynamically imported module/);
    expect(reload).not.toHaveBeenCalled();
  });

  test("still works when the server is built minified, as production builds it", async () => {
    // The stub embeds `chunkReloadGuard`'s source, so that function must stay
    // self-contained through the build (`scripts/build.ts` minifies).
    const build = await Bun.build({
      entrypoints: [join(import.meta.dirname, "chunkLoadRecovery.ts")],
      target: "bun",
      format: "cjs",
      minify: true,
    });
    expect(build.success).toBe(true);
    const built = { exports: {} as { chunkReloadStubScript: typeof chunkReloadStubScript } };
    // Bun's CJS output is one `(function (exports, require, module, …) {…})`.
    const source = (await build.outputs[0]!.text()).replace(/^\/\/.*\n/, "");
    new Function(`return ${source}`)()(built.exports, undefined, built);
    const stub = built.exports.chunkReloadStubScript("/assets/Home-x.js");
    const runBuilt = () => new Function(stub.replace(/export \{\}$/, ""))();
    blockSessionStorage("getter");

    runBuilt();
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockClear();
    expect(runBuilt).toThrow(/Failed to fetch dynamically imported module/);
    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  test("a client recovery without sessionStorage holds the stub back too", () => {
    blockSessionStorage("setItem");

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
    reload.mockClear();

    expect(() => run()).toThrow(/Failed to fetch dynamically imported module/);
    expect(reload).not.toHaveBeenCalled();
  });
});

/** Makes `sessionStorage` fail one of the ways a browser can refuse it. */
function blockSessionStorage(how: "getter" | "getItem" | "setItem") {
  const denied = () => {
    throw new DOMException("denied", "SecurityError");
  };
  if (how === "getter") vi.spyOn(window, "sessionStorage", "get").mockImplementation(denied);
  else vi.spyOn(Storage.prototype, how).mockImplementation(denied);
}

/** A fresh document in the same tab: memory is gone, `window.name` is not. */
function nextDocument() {
  reload.mockClear();
  assign.mockClear();
  __resetChunkLoadRecovery();
}

describe("without sessionStorage, the window.name fallback (#1186)", () => {
  test.each(["getter", "getItem", "setItem"] as const)(
    "a %s failure: one recovery, then the same page is refused inside the cooldown",
    (how) => {
      blockSessionStorage(how);

      expect(recoverFromChunkLoadError(chunkError(), { source: "navigation" })).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);

      nextDocument();
      const onChunkLoadError = vi.fn();
      configureChunkLoadRecovery({ onChunkLoadError });
      expect(recoverFromChunkLoadError(chunkError(), { source: "navigation" })).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(onChunkLoadError).toHaveBeenCalledWith(expect.objectContaining({ blocked: "cooldown" }));
    },
  );

  test("is not touched while sessionStorage works", () => {
    recoverFromChunkLoadError(chunkError());

    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.name).toBe("");
  });

  test("another page recovers independently, and a build mismatch shares the guard", () => {
    blockSessionStorage("getter");
    vi.useFakeTimers({ now: 1_000_000 });

    recoverFromChunkLoadError(chunkError());
    nextDocument();
    expect(recoverFromChunkLoadError(chunkError(), { url: "https://app.test/settings" })).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://app.test/settings");

    nextDocument();
    expect(
      recoverFromBuildMismatch({ url: "https://app.test/settings", clientBuild: "a", serverBuild: "b" }),
    ).toBe(false);
    expect(
      recoverFromBuildMismatch({ url: "https://app.test/reports", clientBuild: "a", serverBuild: "b" }),
    ).toBe(true);
  });

  test("after the cooldown the same page may recover again, and nothing retries on its own", () => {
    blockSessionStorage("getter");
    vi.useFakeTimers({ now: 1_000_000 });

    recoverFromChunkLoadError(chunkError());
    nextDocument();
    vi.advanceTimersByTime(31_000);
    expect(reload).not.toHaveBeenCalled();

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("holds no URL, path or query, only short hashes", () => {
    blockSessionStorage("getter");

    recoverFromChunkLoadError(chunkError(), { url: "https://app.test/invite?token=s3cr3t" });

    expect(assign).toHaveBeenCalledTimes(1);
    expect(window.name).not.toMatch(/app\.test|invite|token|s3cr3t|https/);
    const marker = JSON.parse(window.name.slice(`${CHUNK_RELOAD_MARKER}:`.length));
    expect(marker.o).toMatch(/^[0-9a-z]{1,7}$/);
    expect(Object.keys(marker.m)).toEqual([expect.stringMatching(/^[0-9a-z]{1,7}$/)]);
    expect(Object.values(marker.m)).toEqual([expect.any(Number)]);
  });

  test("the query does not make a new destination", () => {
    blockSessionStorage("getter");

    recoverFromChunkLoadError(chunkError(), { url: "https://app.test/invite?token=a" });
    nextDocument();

    expect(recoverFromChunkLoadError(chunkError(), { url: "https://app.test/invite?token=b" })).toBe(false);
  });

  test("leaves a window.name of the app's own alone and fails closed", () => {
    blockSessionStorage("setItem");
    window.name = '{"app":"state"}';
    const onChunkLoadError = vi.fn();
    configureChunkLoadRecovery({ onChunkLoadError });

    // Reads worked, so the hook was told it would reload; the write found no
    // marker that would survive, so nothing loads.
    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(onChunkLoadError).toHaveBeenCalledWith(expect.objectContaining({ blocked: null }));
    expect(reload).not.toHaveBeenCalled();
    expect(window.name).toBe('{"app":"state"}');
  });

  test("does not navigate when the window.name write does not stick", () => {
    blockSessionStorage("getter");
    vi.spyOn(window, "name", "set").mockImplementation(() => {});

    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  test("does not navigate when window.name cannot be read either", () => {
    blockSessionStorage("getter");
    vi.spyOn(window, "name", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const onChunkLoadError = vi.fn();
    configureChunkLoadRecovery({ onChunkLoadError });

    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(onChunkLoadError).toHaveBeenCalledWith(expect.objectContaining({ blocked: "storage" }));
    expect(reload).not.toHaveBeenCalled();
  });

  test("a malformed marker holds no reloads and is replaced", () => {
    blockSessionStorage("getter");
    window.name = `${CHUNK_RELOAD_MARKER}:{not json`;

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
    expect(() => JSON.parse(window.name.slice(`${CHUNK_RELOAD_MARKER}:`.length))).not.toThrow();

    for (const junk of ["[1,2]", '{"o":5,"m":"x"}', '{"m":{"a":"soon"}}', "null"]) {
      window.name = `${CHUNK_RELOAD_MARKER}:${junk}`;
      nextDocument();
      expect(recoverFromChunkLoadError(chunkError())).toBe(true);
    }
  });

  test("a marker another origin wrote holds no reloads here", () => {
    blockSessionStorage("getter");
    recoverFromChunkLoadError(chunkError());
    const written = window.name;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "https://other.test/dashboard", reload, assign },
    });
    nextDocument();
    window.name = written;

    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
  });

  test("a marker from the future (clock set back) does not block recovery", () => {
    blockSessionStorage("getter");
    vi.useFakeTimers({ now: 10_000_000 });
    recoverFromChunkLoadError(chunkError());
    nextDocument();

    vi.setSystemTime(1_000_000);
    expect(recoverFromChunkLoadError(chunkError())).toBe(true);
  });

  test("offline and a hook's veto still hold, and a veto writes nothing", () => {
    blockSessionStorage("getter");
    configureChunkLoadRecovery({ onChunkLoadError: () => false });
    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(window.name).toBe("");

    configureChunkLoadRecovery({});
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(recoverFromChunkLoadError(chunkError())).toBe(false);
    expect(window.name).toBe("");
    expect(reload).not.toHaveBeenCalled();
  });

  test("errors that are not chunk failures do not use it", () => {
    blockSessionStorage("getter");

    expect(recoverFromChunkLoadError(new TypeError("x is not a function"))).toBe(false);
    expect(window.name).toBe("");
  });
});
