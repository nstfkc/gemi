import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createUnsatisfiableResponse } from "../http/createStreamResponse";
import { formatContentRange, parseRangeHeader, resolveRange } from "../http/range";
import { SIBLING_EXTENSION } from "../vite/precompressAssets";
import { type ContentEncoding, negotiateEncoding } from "./compression";
import { generateETag } from "./generateEtag";

/**
 * Every file in `dist/client` outside `/assets`, as absolute paths — what
 * Vite copied out of `public/` (#583).
 *
 * A root-level path may be an app route, so the static handler may only take
 * one that names a file the app really ships. This used to be guessed from the
 * extension, and every extension the list missed (`.mp4` on 0.58, `.wasm`,
 * `.csv` …) was answered by the router with a rendered 404 page. The build
 * output is fixed for the life of the process, so the exact set is read once
 * at boot instead.
 *
 * `assets/` is left out because the static handler takes everything under it
 * anyway. A name starting with a dot is left out at any depth: `.vite/` is
 * build metadata (both manifests and the asset base record), and a stray
 * `.DS_Store` or `.env` copied in from `public/` is nothing a request should
 * reach. `/.well-known` is served by its own rule.
 */
export async function listPublicFiles(clientDir: string): Promise<Set<string>> {
  const files = new Set<string>();

  async function walk(dir: string, topLevel: boolean) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (topLevel && entry.name === "assets") continue;
      const path = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(path);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue;
        }
      }
      if (isFile) files.add(path);
      // A symlinked directory is not followed: a link back up the tree would
      // never end, and `clientFilePath` only names paths inside `dist/client`.
      else if (isDir && !entry.isSymbolicLink()) await walk(path, false);
    }
  }

  await walk(clientDir, true);
  return files;
}

const LONG_LIVED = "public, max-age=31536000, must-revalidate";

/**
 * A content-hashed build asset never changes under its name: a new build
 * writes a new name. So a browser or edge may keep it a year without asking
 * again (#789).
 */
const IMMUTABLE = "public, max-age=31536000, immutable";

export interface StaticFileOptions {
  /**
   * The file is a content-hashed build asset (it is in the build's
   * `static-assets.json`), so it is sent as `immutable`.
   */
  immutable?: boolean;
  /**
   * The precompressed siblings the build wrote for it (`file.br`,
   * `file.gz`), in preference order. Offering any makes the response vary by
   * `Accept-Encoding`, so it says so even when it sends identity.
   */
  encodings?: ContentEncoding[];
}

async function encodedSibling(
  req: Request,
  path: string,
  encodings: ContentEncoding[],
): Promise<{ encoding: ContentEncoding; path: string; size: number } | null> {
  // A range is a byte range of the identity representation: an encoded
  // variant has no stable offsets to slice, so a range request gets identity.
  if (encodings.length === 0 || req.headers.has("Range")) {
    return null;
  }
  const encoding = negotiateEncoding(req.headers.get("Accept-Encoding"), encodings);
  if (!encoding) {
    return null;
  }
  const siblingPath = path + SIBLING_EXTENSION[encoding];
  try {
    // Checked per request, like the file itself: a sibling deleted under a
    // running server would otherwise fail mid-body after a committed 200.
    const info = await stat(siblingPath);
    return info.isFile() ? { encoding, path: siblingPath, size: info.size } : null;
  } catch {
    return null;
  }
}

/**
 * The response for a file in `dist/client` that is known to exist.
 *
 * Honours a single byte `Range`, so a `<video>` pointed at a public `.mp4`
 * can seek — Safari will not play one at all from a server that answers its
 * `bytes=0-1` probe with the whole file. Recent Bun releases slice a
 * file-backed 200 themselves; doing it here keeps that from depending on the
 * Bun version a deployment runs, and answers an unsatisfiable range with the
 * same 416 the `stream()` responses use.
 *
 * A build asset with precompressed siblings is sent as the one
 * `Accept-Encoding` prefers (brotli, then gzip, then identity), with the
 * original's `Content-Type`. Nothing is compressed here: a file without a
 * sibling is sent as is.
 *
 * `Bun.file().type` is the mime lookup, and is `application/octet-stream` for
 * an extension it does not know.
 */
export async function staticFileResponse(
  req: Request,
  path: string,
  options: StaticFileOptions = {},
): Promise<Response> {
  const file = Bun.file(path);
  const encodings = options.encodings ?? [];

  const headers: Record<string, string> = {
    "Content-Type": file.type || "application/octet-stream",
    "Cache-Control": options.immutable ? IMMUTABLE : LONG_LIVED,
    "Accept-Ranges": "bytes",
  };
  if (encodings.length > 0) {
    headers.Vary = "Accept-Encoding";
  }

  const sibling = await encodedSibling(req, path, encodings);
  if (sibling) {
    const encoded = Bun.file(sibling.path);
    return new Response(encoded.stream(), {
      headers: {
        ...headers,
        "Content-Encoding": sibling.encoding,
        "Content-Length": String(sibling.size),
        // A different representation, so a different validator.
        ETag: `${generateETag(encoded.lastModified)}-${sibling.encoding}`,
      },
    });
  }

  const total = file.size;
  headers.ETag = generateETag(file.lastModified);

  const range = parseRangeHeader(req.headers.get("Range"));

  if (range) {
    const resolved = resolveRange(range, total);
    if (!resolved) {
      return createUnsatisfiableResponse(total);
    }
    return new Response(file.slice(resolved.start, resolved.end + 1).stream(), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": formatContentRange(resolved.start, resolved.end, total),
        "Content-Length": String(resolved.length),
      },
    });
  }

  return new Response(file.stream(), {
    headers: { ...headers, "Content-Length": String(total) },
  });
}
