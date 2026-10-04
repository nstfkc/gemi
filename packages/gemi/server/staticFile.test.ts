import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { gzipSync, brotliCompressSync } from "node:zlib";

import { listPublicFiles, staticFileResponse } from "./staticFile";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gemi-public-files-"));
  await mkdir(join(dir, "assets/nested"), { recursive: true });
  await mkdir(join(dir, ".vite"), { recursive: true });
  await mkdir(join(dir, "v2/video"), { recursive: true });
  await mkdir(join(dir, "docs/assets"), { recursive: true });
  await writeFile(join(dir, "assets/app.js"), "");
  await writeFile(join(dir, "assets/nested/x.png"), "");
  await writeFile(join(dir, ".vite/manifest.json"), "{}");
  await writeFile(join(dir, ".DS_Store"), "");
  await writeFile(join(dir, "favicon.ico"), "");
  await writeFile(join(dir, "v2/video/clip.mp4"), "");
  await writeFile(join(dir, "v2/video/.env"), "");
  await writeFile(join(dir, "docs/assets/guide.pdf"), "");
  await symlink(join(dir, "favicon.ico"), join(dir, "linked.ico"));
  // A directory link back up the tree: following it would never end.
  await symlink(dir, join(dir, "loop"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("listPublicFiles", () => {
  test("lists every file outside /assets and dot-names, at any depth", async () => {
    const files = await listPublicFiles(dir);

    expect([...files].map((f) => f.slice(dir.length)).sort()).toEqual([
      "/docs/assets/guide.pdf",
      "/favicon.ico",
      "/linked.ico",
      "/v2/video/clip.mp4",
    ]);
  });

  test("is empty for a missing directory", async () => {
    expect((await listPublicFiles(join(dir, "nope"))).size).toBe(0);
  });
});

describe("staticFileResponse", () => {
  const source = "export const answer = 42;\n".repeat(100);
  let assets: string;
  let chunk: string;

  beforeAll(async () => {
    assets = await mkdtemp(join(tmpdir(), "gemi-static-response-"));
    chunk = join(assets, "client-abc.js");
    await writeFile(chunk, source);
    await writeFile(`${chunk}.br`, brotliCompressSync(source));
    await writeFile(`${chunk}.gz`, gzipSync(source));
  });

  afterAll(async () => {
    await rm(assets, { recursive: true, force: true });
  });

  function get(headers: Record<string, string> = {}) {
    return new Request("http://localhost/assets/client-abc.js", { headers });
  }

  test("sends the brotli sibling when it is accepted, with the original's type", async () => {
    const res = await staticFileResponse(get({ "Accept-Encoding": "gzip, deflate, br" }), chunk, {
      immutable: true,
      encodings: ["br", "gzip"],
    });
    const body = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("br");
    expect(res.headers.get("Content-Type")).toMatch(/^text\/javascript/);
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(Number(res.headers.get("Content-Length"))).toBe(body.length);
    expect(body.equals(brotliCompressSync(source))).toBe(true);
  });

  test("falls back to gzip, then identity", async () => {
    const gz = await staticFileResponse(get({ "Accept-Encoding": "gzip" }), chunk, {
      immutable: true,
      encodings: ["br", "gzip"],
    });
    expect(gz.headers.get("Content-Encoding")).toBe("gzip");
    expect(gz.headers.get("ETag")).toMatch(/-gzip$/);

    for (const headers of [
      {},
      { "Accept-Encoding": "identity" },
      { "Accept-Encoding": "br;q=0" },
    ]) {
      const res = await staticFileResponse(get(headers), chunk, {
        immutable: true,
        encodings: ["br", "gzip"],
      });
      expect(res.headers.get("Content-Encoding")).toBeNull();
      expect(res.headers.get("Vary")).toBe("Accept-Encoding");
      expect(await res.text()).toBe(source);
    }
  });

  test("only offers the encodings the build recorded", async () => {
    const res = await staticFileResponse(get({ "Accept-Encoding": "br" }), chunk, {
      immutable: true,
      encodings: ["gzip"],
    });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toBe(source);
  });

  test("a range request gets a 206 slice of the identity file", async () => {
    const res = await staticFileResponse(
      get({ "Accept-Encoding": "br, gzip", Range: "bytes=0-9" }),
      chunk,
      { immutable: true, encodings: ["br", "gzip"] },
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-9/${source.length}`);
    expect(await res.text()).toBe(source.slice(0, 10));
  });

  test("a missing sibling falls back to identity", async () => {
    const lonely = join(assets, "lonely-abc.js");
    await writeFile(lonely, source);
    const res = await staticFileResponse(get({ "Accept-Encoding": "br" }), lonely, {
      immutable: true,
      encodings: ["br"],
    });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toBe(source);
  });

  test("a file outside the build record keeps the old headers and is never encoded", async () => {
    const res = await staticFileResponse(get({ "Accept-Encoding": "br" }), chunk);

    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, must-revalidate");
    expect(await res.text()).toBe(source);
  });
});
