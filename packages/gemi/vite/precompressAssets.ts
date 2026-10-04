import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

import type { ContentEncoding } from "../server/compression";

/**
 * Build-time compression of the client bundle (#789).
 *
 * `gemi start` compresses SSR HTML per request, but a hashed chunk is the same
 * bytes for the life of a release, so compressing it per request would spend
 * origin CPU on every visitor for a result that never changes. `gemi build`
 * writes `file.br` (brotli quality 11) and `file.gz` (gzip level 9) next to
 * every compressible build asset instead, once, and the server picks one by
 * `Accept-Encoding`.
 *
 * What the build emitted (and what it carried over from earlier releases, see
 * `previousAssets.ts`) is recorded in `dist/client/.vite/static-assets.json`,
 * with the encodings each file has. The server reads it at boot: a file in the
 * record is a content-hashed build asset, so it is sent as `immutable`, and
 * only the encodings listed for it are offered. A file not in the record (one
 * copied from `public/assets/`, or anything in a build made before this
 * existed) is served as before.
 */

/** Relative to `dist/client`; beside Vite's own manifest, so never served. */
export const STATIC_ASSETS_RECORD = ".vite/static-assets.json";

/**
 * Below this, the encoded body plus its header is not worth a second request
 * representation: a 600-byte chunk saves a few hundred bytes at most, and
 * every file with siblings adds a `stat` per request.
 */
export const PRECOMPRESS_MIN_BYTES = 1024;

/**
 * Text-like formats that compress well. Already-compressed formats (images,
 * `woff`/`woff2`, video) are left out: brotli shaves a percent or two off
 * them at best. Source maps are left out because a page never loads one, and
 * only devtools would gain from the extra build time.
 */
const COMPRESSIBLE = /\.(?:m?js|cjs|css|svg|json|webmanifest|wasm|txt|xml|ttf|otf|eot)$/i;

const TEXT = /\.(?:m?js|cjs|css|svg|json|webmanifest|txt|xml)$/i;
const FONT = /\.(?:ttf|otf|eot)$/i;

export const SIBLING_EXTENSION: Record<ContentEncoding, string> = {
  br: ".br",
  gzip: ".gz",
};

/** Server preference: brotli is ~15% smaller than gzip -9 on a JS chunk. */
const ENCODINGS: ContentEncoding[] = ["br", "gzip"];

export interface StaticAssetsRecord {
  /**
   * Path relative to `dist/client` (`assets/client-DJhrQPW5.js`) → the
   * precompressed siblings it has, in preference order. An empty list is a
   * build asset that is served as identity only (an image, a small file).
   */
  files: Record<string, ContentEncoding[]>;
}

export interface PrecompressStats {
  files: number;
  identityBytes: number;
  brBytes: number;
  gzipBytes: number;
}

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export function isPrecompressible(file: string): boolean {
  return COMPRESSIBLE.test(file);
}

/** `true` for `x.js.br` / `x.js.gz`: a sibling, not an asset of its own. */
export function isEncodedSibling(file: string): boolean {
  return file.endsWith(".br") || file.endsWith(".gz");
}

async function encode(encoding: ContentEncoding, file: string, input: Buffer): Promise<Buffer> {
  if (encoding === "gzip") {
    return gzipAsync(input, { level: 9 });
  }
  return brotli(input, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_MODE]: TEXT.test(file)
        ? constants.BROTLI_MODE_TEXT
        : FONT.test(file)
          ? constants.BROTLI_MODE_FONT
          : constants.BROTLI_MODE_GENERIC,
      [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
    },
  });
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Writes the `.br`/`.gz` siblings of `files` (paths relative to `clientDir`)
 * and returns the encodings each one ended up with.
 *
 * A sibling is only kept when it is smaller than the file itself; one that is
 * not would cost bytes on the wire, so the file is served as identity for
 * that encoding. With `reuseExisting`, a sibling already on disk is trusted
 * rather than rebuilt — for files carried from an earlier release, whose
 * siblings were copied with them and match by content hash.
 */
export async function precompressAssets(
  clientDir: string,
  files: Iterable<string>,
  options: {
    reuseExisting?: boolean;
    minBytes?: number;
    concurrency?: number;
  } = {},
): Promise<{ record: StaticAssetsRecord; stats: PrecompressStats }> {
  const minBytes = options.minBytes ?? PRECOMPRESS_MIN_BYTES;
  const record: StaticAssetsRecord = { files: {} };
  const stats: PrecompressStats = {
    files: 0,
    identityBytes: 0,
    brBytes: 0,
    gzipBytes: 0,
  };

  const queue = [...new Set(files)];
  for (const file of queue) {
    record.files[file] = [];
  }

  async function work(file: string) {
    if (!isPrecompressible(file)) {
      return;
    }
    const path = join(clientDir, file);
    const size = await fileSize(path);
    if (size === null || size < minBytes) {
      return;
    }

    let input: Buffer | null = null;
    const available: ContentEncoding[] = [];
    const sizes: Partial<Record<ContentEncoding, number>> = {};
    for (const encoding of ENCODINGS) {
      const siblingPath = path + SIBLING_EXTENSION[encoding];
      const existing = options.reuseExisting ? await fileSize(siblingPath) : null;
      if (existing !== null) {
        if (existing < size) {
          available.push(encoding);
          sizes[encoding] = existing;
        }
        continue;
      }
      input ??= await readFile(path);
      const output = await encode(encoding, file, input);
      if (output.length < size) {
        await writeFile(siblingPath, output);
        available.push(encoding);
        sizes[encoding] = output.length;
      }
    }

    record.files[file] = available;
    if (available.length > 0) {
      stats.files += 1;
      stats.identityBytes += size;
      stats.brBytes += sizes.br ?? size;
      stats.gzipBytes += sizes.gzip ?? size;
    }
  }

  // zlib's async calls run on the libuv thread pool; a few files in flight
  // keep it busy without reading the whole bundle into memory at once.
  const concurrency = Math.max(1, options.concurrency ?? Math.min(8, availableParallelism()));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (next < queue.length) {
        await work(queue[next++]);
      }
    }),
  );

  return { record, stats };
}

export async function writeStaticAssetsRecord(clientDir: string, record: StaticAssetsRecord) {
  const path = join(clientDir, STATIC_ASSETS_RECORD);
  await mkdir(dirname(path), { recursive: true });
  // Sorted, so two builds of the same tree write the same file.
  const files = Object.fromEntries(
    Object.entries(record.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  await writeFile(path, `${JSON.stringify({ files }, null, 2)}\n`);
}

/**
 * The record a build wrote, or `null` when there is none (a build made before
 * precompression, or an incomplete `dist/`): the server then serves every file
 * as before. A malformed entry is dropped rather than trusted.
 */
export async function readStaticAssetsRecord(
  clientDir: string,
): Promise<StaticAssetsRecord | null> {
  let raw: string;
  try {
    raw = await readFile(join(clientDir, STATIC_ASSETS_RECORD), "utf8");
  } catch {
    return null;
  }
  let files: unknown;
  try {
    files = JSON.parse(raw)?.files;
  } catch {
    return null;
  }
  if (!files || typeof files !== "object") {
    return null;
  }
  const record: StaticAssetsRecord = { files: {} };
  for (const [file, encodings] of Object.entries(files)) {
    if (!Array.isArray(encodings)) continue;
    record.files[file] = ENCODINGS.filter((encoding) => encodings.includes(encoding));
  }
  return record;
}
