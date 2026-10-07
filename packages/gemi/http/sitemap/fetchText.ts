import type { SafeFetchOptions, SafeResponse } from "../safeFetch/safeFetch";
import { TooLargeError } from "../safeFetch/errors";

/**
 * What `Robots.fetch` and `Sitemap.read` pass on to `safeFetch`. The method,
 * body and redirect mode are theirs, and `maxSize` is their own option.
 */
export type ReaderFetchOptions = Omit<
  SafeFetchOptions,
  "method" | "body" | "redirect" | "contentTypes" | "maxSize"
>;

/**
 * The body's bytes, decoded and capped at `maxSize`. A gzip file (`.xml.gz`,
 * which arrives as `application/gzip` rather than with `Content-Encoding`) is
 * inflated, and the cap applies to the inflated bytes, so a small bomb can't
 * expand past it. With `truncate`, the bytes up to the cap are kept rather
 * than throwing.
 */
export async function readBytes(
  response: SafeResponse,
  maxSize: number,
  truncate = false,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const [head, stream] = await peek(response.body);
  const gzipped = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const source = gzipped
    ? stream.pipeThrough(
        new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
      )
    : stream;
  return collect(source, maxSize, truncate, response.url);
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  maxSize: number,
  truncate: boolean,
  url: string,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxSize) {
        if (!truncate) throw new TooLargeError(url, maxSize);
        chunks.push(value.subarray(0, maxSize - total));
        total = maxSize;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Stops the download (and any inflating) once we have what we keep.
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The first chunk, and a stream that still starts with it. */
async function peek(
  body: ReadableStream<Uint8Array>,
): Promise<[Uint8Array, ReadableStream<Uint8Array>]> {
  const reader = body.getReader();
  const first = await reader.read();
  const head = first.done ? new Uint8Array() : first.value;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(head);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return [head, stream];
}

export function decodeText(bytes: Uint8Array) {
  // Sitemaps and robots.txt are UTF-8 by their specs; the decoder drops a BOM.
  return new TextDecoder("utf-8").decode(bytes);
}
