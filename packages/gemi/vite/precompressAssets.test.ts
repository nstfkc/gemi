import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  STATIC_ASSETS_RECORD,
  precompressAssets,
  readStaticAssetsRecord,
  writeStaticAssetsRecord,
} from "./precompressAssets";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gemi-precompress-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(files: Record<string, string | Buffer>) {
  for (const [file, content] of Object.entries(files)) {
    const path = join(dir, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

const js = "export const greeting = 'hello world';\n".repeat(200);
const css = ".button { color: red; padding: 4px 8px; }\n".repeat(100);

describe("precompressAssets", () => {
  test("writes .br and .gz siblings that decode to the original", async () => {
    await write({ "assets/client-abc.js": js, "assets/main-def.css": css });

    const { record, stats } = await precompressAssets(dir, [
      "assets/client-abc.js",
      "assets/main-def.css",
    ]);

    expect(record.files).toEqual({
      "assets/client-abc.js": ["br", "gzip"],
      "assets/main-def.css": ["br", "gzip"],
    });
    const br = await readFile(join(dir, "assets/client-abc.js.br"));
    const gz = await readFile(join(dir, "assets/client-abc.js.gz"));
    expect(brotliDecompressSync(br).toString()).toBe(js);
    expect(gunzipSync(gz).toString()).toBe(js);
    expect(br.length).toBeLessThan(js.length);
    expect(stats.files).toBe(2);
    expect(stats.identityBytes).toBe(js.length + css.length);
    expect(stats.brBytes).toBeLessThan(stats.gzipBytes);
  });

  test("skips small files, incompressible formats and source maps, but records them", async () => {
    await write({
      "assets/tiny-abc.js": "export {};\n",
      "assets/logo-abc.png": Buffer.alloc(4096, 1),
      "assets/font-abc.woff2": Buffer.alloc(4096, 1),
      "assets/client-abc.js.map": js,
    });

    const { record, stats } = await precompressAssets(dir, [
      "assets/tiny-abc.js",
      "assets/logo-abc.png",
      "assets/font-abc.woff2",
      "assets/client-abc.js.map",
    ]);

    expect(Object.values(record.files)).toEqual([[], [], [], []]);
    expect(stats.files).toBe(0);
    for (const file of Object.keys(record.files)) {
      expect(existsSync(join(dir, `${file}.br`))).toBe(false);
      expect(existsSync(join(dir, `${file}.gz`))).toBe(false);
    }
  });

  test("keeps no sibling that is not smaller than the file", async () => {
    // Random bytes do not compress; a sibling would only add bytes.
    const random = Buffer.from(Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256)));
    await write({ "assets/blob-abc.wasm": random });

    const { record } = await precompressAssets(dir, ["assets/blob-abc.wasm"]);

    expect(record.files["assets/blob-abc.wasm"]).toEqual([]);
    expect(existsSync(join(dir, "assets/blob-abc.wasm.br"))).toBe(false);
  });

  test("reuses a sibling already on disk only when asked to", async () => {
    await write({ "assets/old-abc.js": js, "assets/old-abc.js.br": "carried" });

    await precompressAssets(dir, ["assets/old-abc.js"], {
      reuseExisting: true,
    });
    expect(await readFile(join(dir, "assets/old-abc.js.br"), "utf8")).toBe("carried");
    // The missing gzip sibling is written.
    expect(gunzipSync(await readFile(join(dir, "assets/old-abc.js.gz"))).toString()).toBe(js);

    await precompressAssets(dir, ["assets/old-abc.js"]);
    expect(brotliDecompressSync(await readFile(join(dir, "assets/old-abc.js.br"))).toString()).toBe(
      js,
    );
  });

  test("a missing file is recorded with no encodings", async () => {
    const { record } = await precompressAssets(dir, ["assets/gone-abc.js"]);
    expect(record.files).toEqual({ "assets/gone-abc.js": [] });
  });
});

describe("static assets record", () => {
  test("round-trips through dist/client/.vite", async () => {
    await writeStaticAssetsRecord(dir, {
      files: { "assets/b.js": ["br", "gzip"], "assets/a.png": [] },
    });

    const raw = await readFile(join(dir, STATIC_ASSETS_RECORD), "utf8");
    expect(Object.keys(JSON.parse(raw).files)).toEqual(["assets/a.png", "assets/b.js"]);
    expect(await readStaticAssetsRecord(dir)).toEqual({
      files: { "assets/a.png": [], "assets/b.js": ["br", "gzip"] },
    });
  });

  test("is null when missing or malformed, and drops unknown encodings", async () => {
    expect(await readStaticAssetsRecord(dir)).toBeNull();

    await write({ [STATIC_ASSETS_RECORD]: "{not json" });
    expect(await readStaticAssetsRecord(dir)).toBeNull();

    await write({
      [STATIC_ASSETS_RECORD]: JSON.stringify({
        files: { "assets/a.js": ["zstd", "gzip"], "assets/b.js": "br" },
      }),
    });
    expect(await readStaticAssetsRecord(dir)).toEqual({
      files: { "assets/a.js": ["gzip"] },
    });
  });
});
