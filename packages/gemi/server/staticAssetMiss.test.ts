import { describe, expect, test } from "vitest";

import { isBuildChunkPath, staticAssetMiss } from "./staticAssetMiss";

/**
 * What `httpProd` answers when a static-looking request has no file behind it
 * in `dist/client`. `undefined` means "hand it to the app".
 */

describe("a missing build chunk", () => {
  test("is answered with the reload stub", async () => {
    const res = staticAssetMiss("/assets/Dashboard-CRSTVHPB.js");

    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("application/javascript");
    expect(await res?.text()).toContain("window.location.reload()");
  });

  test("is never cached", () => {
    // The stub stands in for one release's chunk under that chunk's URL. An
    // edge or a browser holding on to it would keep reloading the page after
    // the real chunk is back.
    const res = staticAssetMiss("/assets/Dashboard-CRSTVHPB.js");

    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  test("includes `.mjs`", () => {
    expect(isBuildChunkPath("/assets/client-abc.mjs")).toBe(true);
  });

  test("is only the reload: it names no server path and never reads `caches`", async () => {
    // The body used to open with `if(caches){caches?.delete("<distPath>")}`.
    // `CacheStorage.delete` takes a cache name, so the path deleted nothing;
    // it published `dist/` absolute layout to anyone asking for a missing
    // chunk; and `caches` is `[SecureContext]`, so on a plain-http origin
    // reading it threw a ReferenceError and the page never reloaded.
    const body = (await staticAssetMiss("/assets/Dashboard-CRSTVHPB.js")?.text()) ?? "";

    expect(body).not.toContain("caches");
    expect(body).not.toContain("dist");
    expect(body).toBe("window.location.reload();export {}");
  });
});

describe("a miss that only looks like a chunk", () => {
  test("a source map under /assets is a 404, not a reload", () => {
    // `includes(".js")` matched this, and answered devtools' request for a
    // map with a script.
    const res = staticAssetMiss("/assets/Dashboard-CRSTVHPB.js.map");

    expect(res?.status).toBe(404);
    expect(res?.headers.get("Cache-Control")).toBeNull();
  });

  test("JSON under /assets is a 404, not a reload", () => {
    // The helper's contract only: `gemi start` never asks it about `.json`,
    // since `json` is not in httpProd's staticFilePattern, and such a request
    // goes to the app before a miss can happen.
    const res = staticAssetMiss("/assets/data.json");

    expect(res?.status).toBe(404);
  });

  test("a `.js` path outside /assets goes to the app", () => {
    // Not a build chunk, so possibly an app route; and a classic
    // `<script src>` answered with a reload reloads forever.
    expect(staticAssetMiss("/vendor/analytics.js")).toBeUndefined();
    expect(staticAssetMiss("/files.js/logo.png")).toBeUndefined();
  });

  test("any other miss under /assets is a 404", () => {
    expect(staticAssetMiss("/assets/lazy-abc.css")?.status).toBe(404);
    expect(staticAssetMiss("/assets")?.status).toBe(404);
  });

  test("any other miss outside /assets goes to the app", () => {
    expect(staticAssetMiss("/files/logo.svg")).toBeUndefined();
  });
});
