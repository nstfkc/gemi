import { contentDisposition } from "./contentDisposition";
import {
  formatContentRange,
  formatUnsatisfiedContentRange,
  resolveRange,
  type ByteRange,
} from "./range";
import type { ReadResult } from "../services/file-storage/drivers/types";

export type StreamBody =
  | Blob
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | ArrayBufferView;

export type StreamDescriptor = {
  file: StreamBody;
  /** File name sent in `Content-Disposition`. Defaults to the blob name, if any. */
  name?: string;
  /** Overrides the mime type. Defaults to the blob type, then `application/octet-stream`. */
  type?: string;
  /** `true` sends `attachment` (download), `false` (default) sends `inline`. */
  download?: boolean;
  /** Total size of the complete object. Required when `file` is a stream, or ranges cannot be served. */
  total?: number;
  start?: number;
  end?: number;
  /** Set when `file` already holds only the requested window. */
  partial?: boolean;
  etag?: string;
  lastModified?: Date;
  status?: number;
  headers?: Record<string, string>;
};

export type StreamOutput =
  | ReadResult
  | Blob
  | Response
  | StreamDescriptor
  | null
  | undefined;

type Normalized = {
  body: StreamBody | null;
  start: number;
  end: number;
  total: number;
  partial: boolean;
  type: string;
  name?: string;
  download: boolean;
  etag?: string;
  lastModified?: Date;
  status: number;
  extraHeaders: Record<string, string>;
};

function isReadResult(output: object): output is ReadResult {
  return "total" in output && "partial" in output && "body" in output;
}

/** A 416, whose `Content-Range` reports the current size and no offsets. */
export function createUnsatisfiableResponse(total: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": formatUnsatisfiedContentRange(total),
      "Content-Length": "0",
      // A 416 is a function of the client's own Range against the object's
      // current length. A cache that replayed it to a request which asked for
      // no range, or a different one, would be serving a wrong answer.
      "Cache-Control": "no-store",
    },
  });
}

async function normalize(output: Exclude<StreamOutput, Response | null | undefined>) {
  if (output instanceof Blob) {
    return {
      body: output,
      start: 0,
      end: output.size - 1,
      total: output.size,
      partial: false,
      type: output.type,
      name: (output as File).name,
      download: false,
      status: 200,
      extraHeaders: {},
    } satisfies Normalized;
  }

  if (isReadResult(output)) {
    return {
      body: output.body,
      start: output.start,
      end: output.end,
      total: output.total,
      partial: output.partial,
      type: output.type,
      name: output.name,
      download: false,
      etag: output.etag,
      lastModified: output.lastModified,
      status: 200,
      extraHeaders: {},
    } satisfies Normalized;
  }

  const body = output.file;
  const blob = body instanceof Blob ? body : null;
  const total = output.total ?? blob?.size ?? -1;

  return {
    body,
    start: output.start ?? 0,
    end: output.end ?? total - 1,
    total,
    partial: output.partial ?? false,
    type: output.type ?? blob?.type ?? "",
    name: output.name ?? (body as File)?.name,
    download: output.download ?? false,
    etag: output.etag,
    lastModified: output.lastModified,
    status: output.status ?? 200,
    extraHeaders: output.headers ?? {},
  } satisfies Normalized;
}

/**
 * Turns what a `this.stream()` handler returned into an HTTP response,
 * applying RFC 7233 range semantics.
 *
 * Builds a fresh `Headers` rather than taking the request context's: merging
 * context headers and cookies is the router container's job, and doing it in
 * both places would append `Set-Cookie` twice.
 */
export async function createStreamResponse(
  output: StreamOutput,
  options: { range: ByteRange | null; method?: string },
): Promise<Response> {
  // A handler that built its own Response owns it completely.
  if (output instanceof Response) {
    return output;
  }

  if (!output) {
    return new Response("Not found", { status: 404 });
  }

  const normalized = await normalize(output);
  let { body, start, end, total, partial } = normalized;

  // `Bun.file()` is lazy, so a missing path would otherwise only fail once the
  // stream is pulled, with a 200 already committed.
  if (
    body instanceof Blob &&
    "exists" in body &&
    typeof (body as any).exists === "function"
  ) {
    if (!(await (body as any).exists())) {
      return new Response("Not found", { status: 404 });
    }
  }

  const { range } = options;

  if (range) {
    // Must come before anything formats a Content-Range: an empty object has
    // no satisfiable window, and `bytes 0--1/0` is not a legal header.
    if (total <= 0) {
      return createUnsatisfiableResponse(Math.max(total, 0));
    }

    if (!partial) {
      if (body instanceof Blob) {
        // The driver handed back the whole object, but we hold a sized blob,
        // so the window can still be served without reading past it.
        const resolved = resolveRange(range, total);
        if (!resolved) {
          return createUnsatisfiableResponse(total);
        }
        body = body.slice(resolved.start, resolved.end + 1);
        start = resolved.start;
        end = resolved.end;
        partial = true;
      }
      // Otherwise the body is an unsized stream and the range cannot be
      // honoured. RFC 7233 §4.1 permits ignoring a Range, so serve the
      // complete representation with a 200 rather than lying with a 206.
    }
  }

  const isPartial = Boolean(range) && partial;
  const status = isPartial ? 206 : normalized.status;

  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Type", normalized.type || "application/octet-stream");

  if (isPartial) {
    headers.set("Content-Range", formatContentRange(start, end, total));
    headers.set("Content-Length", String(end - start + 1));
  } else if (total >= 0) {
    headers.set("Content-Length", String(total));
  }

  if (normalized.name) {
    headers.set(
      "Content-Disposition",
      contentDisposition(normalized.name, normalized.download),
    );
  }
  if (normalized.etag) {
    headers.set("ETag", normalized.etag);
  }
  if (normalized.lastModified) {
    headers.set("Last-Modified", normalized.lastModified.toUTCString());
  }

  // The handler's own headers win over everything computed above.
  for (const [key, value] of Object.entries(normalized.extraHeaders)) {
    headers.set(key, value);
  }

  if ((options.method ?? "GET").toUpperCase() === "HEAD") {
    // Nothing downstream strips the body for us — `app.fetch()` has no such
    // layer — and an abandoned S3 stream would leak the connection.
    if (body && "cancel" in body && typeof body.cancel === "function") {
      await body.cancel();
    }
    return new Response(null, { status, headers });
  }

  // A Blob is passed through as-is rather than as `.stream()`: Bun drops an
  // explicitly set Content-Length and falls back to chunked encoding for any
  // stream body, but keeps it for a sized blob.
  return new Response(body as BodyInit, { status, headers });
}
