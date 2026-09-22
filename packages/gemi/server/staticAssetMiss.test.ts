import { describe, expect, test } from "vitest";

import { isBuildChunkPath, staticAssetMiss } from "./staticAssetMiss";

/**
 * What `httpProd` answers when a static-looking request has no file behind it
 * in `dist/client`. `undefined` means "hand it to the app".
 */

const distPath = "/srv/app/dist/client/assets/missing.js";

describe("a missing build chunk", () => {
  test("is answered with the reload stub", async () => {
    const res = staticAssetMiss("/assets/Dashboard-CRSTVHPB.js", distPath);

    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("application/javascript");
    expect(await res?.text()).toContain("window.location.reload()");
  });

  test("is never cached", () => {
    // The stub stands in for one release's chunk under that chunk's URL. An
    // edge or a browser holding on to it would keep reloading the page after
    // the real chunk is back.
    const res = staticAssetMiss("/assets/Dashboard-CRSTVHPB.js", distPath);

    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  test("includes `.mjs`", () => {
    expect(isBuildChunkPath("/assets/client-abc.mjs")).toBe(true);
  });
});

describe("a miss that only looks like a chunk", () => {
  test("a source map under /assets is a 404, not a reload", () => {
    // `includes(".js")` matched this, and answered devtools' request for a
    // map with a script.
    const res = staticAssetMiss("/assets/Dashboard-CRSTVHPB.js.map", distPath);

    expect(res?.status).toBe(404);
    expect(res?.headers.get("Cache-Control")).toBeNull();
  });

  test("JSON under /assets is a 404, not a reload", () => {
    const res = staticAssetMiss("/assets/data.json", distPath);

    expect(res?.status).toBe(404);
  });

  test("a `.js` path outside /assets goes to the app", () => {
    // Not a build chunk, so possibly an app route; and a classic
    // `<script src>` answered with a reload reloads forever.
    expect(staticAssetMiss("/vendor/analytics.js", distPath)).toBeUndefined();
    expect(staticAssetMiss("/files.js/logo.png", distPath)).toBeUndefined();
  });

  test("any other miss under /assets is a 404", () => {
    expect(staticAssetMiss("/assets/lazy-abc.css", distPath)?.status).toBe(404);
    expect(staticAssetMiss("/assets", distPath)?.status).toBe(404);
  });

  test("any other miss outside /assets goes to the app", () => {
    expect(staticAssetMiss("/files/logo.svg", distPath)).toBeUndefined();
  });
});
