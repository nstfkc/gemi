import {
  ContentTypeError,
  HttpStatusError,
} from "../../http/safeFetch/errors";
import {
  safeFetch,
  type SafeFetchOptions,
} from "../../http/safeFetch/safeFetch";
import type { IFileStorageDriver, PutStreamParams } from "./drivers/types";
import { FileStorageDriver } from "./drivers/FileStorageDriver";
import {
  SNIFF_BYTES,
  extensionFor,
  isAllowedContentType,
  sniffContentType,
} from "./sniffContentType";

export interface PutFromUrlOptions {
  /**
   * The object name to store under, e.g. `"sites/42/logo.png"`. Without it
   * the name is generated: `<directory>/<uuid v7>.<extension of the sniffed
   * type>`. Pass `name` or `directory`, not both.
   */
  name?: string;
  /** The folder a generated name goes in, e.g. `"sites/42"`. */
  directory?: string;
  /** Bucket or container. Defaults as in `put()`. */
  bucket?: string;
  /**
   * Largest file accepted, in bytes (after decompression). Checked against
   * `Content-Length` up front and again while the body streams in. Default
   * 10 MiB, as in `safeFetch`.
   */
  maxSize?: number;
  /** The whole download in ms, redirects and body included. Default 30 000. */
  timeout?: number;
  /**
   * Media types the file may be, e.g. `["image/*", "application/pdf"]`,
   * checked against the type sniffed from the file's first bytes, not the
   * `Content-Type` header. A wildcard never covers `image/svg+xml`,
   * `text/html` or XML, which can carry script: list them by name to accept
   * them. Anything else rejects with `ContentTypeError` before anything is
   * stored. Default: any type except active content (HTML, XHTML, SVG and
   * XML), which is refused unless listed here by name.
   */
  contentTypes?: readonly string[];
  /** Cancels the download and the upload. */
  signal?: AbortSignal;
  /**
   * Other `safeFetch` options: `headers`, `allow`, `deny`, `ports`,
   * `allowPrivate`, `maxRedirects`, `connectTimeout`, `resolve`. Never build
   * `allowPrivate` from user input.
   */
  fetch?: Omit<
    SafeFetchOptions,
    | "method"
    | "body"
    | "signal"
    | "timeout"
    | "maxSize"
    | "contentTypes"
    | "redirect"
  >;
}

export interface PutFromUrlResult {
  /** The stored object's name, to persist and later pass to `fetch()`/`read()`. */
  name: string;
  /** Sniffed from the file's bytes; the type the object is stored with. */
  contentType: string;
  /** Bytes stored. */
  size: number;
  /** The URL the file was finally downloaded from, after redirects. */
  url: string;
}

/**
 * Downloads `url` through `safeFetch` and stores it with `driver`. The
 * implementation behind `Storage.putFromUrl()`.
 */
export async function putFromUrl(
  driver: IFileStorageDriver,
  url: string | URL,
  options: PutFromUrlOptions = {},
): Promise<PutFromUrlResult> {
  const { name, directory, bucket, maxSize, timeout, contentTypes, signal } =
    options;
  if (name !== undefined && directory !== undefined) {
    throw new TypeError(
      "Storage.putFromUrl(): pass `name` or `directory`, not both.",
    );
  }
  if (name !== undefined && !name) {
    throw new TypeError("Storage.putFromUrl(): `name` is empty.");
  }

  const response = await safeFetch(url, {
    ...options.fetch,
    method: "GET",
    redirect: "follow",
    // Checked against the sniffed bytes below, never against the header.
    contentTypes: undefined,
    signal,
    timeout,
    maxSize,
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpStatusError(response.url, response.status);
  }

  const reader = (response.body ?? new Response(new Uint8Array()).body!).getReader();
  const fail = async (error: unknown): Promise<never> => {
    await reader.cancel(error).catch(() => {});
    throw error;
  };

  // Read just enough to tell what the file is. Size limits, the timeout and
  // the signal already apply: they error this stream.
  const head: Uint8Array[] = [];
  let headSize = 0;
  let ended = false;
  while (headSize < SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    head.push(value);
    headSize += value.byteLength;
  }
  const headBytes = concat(head, headSize);
  const contentType = sniffContentType(
    headBytes.subarray(0, Math.min(headSize, SNIFF_BYTES)),
  );

  // Without `contentTypes`, anything but active content: an HTML or SVG file
  // served back from the app's own origin could run script there.
  const allowed = contentTypes?.length ? contentTypes : ["*/*"];
  if (!isAllowedContentType(contentType, allowed)) {
    await fail(new ContentTypeError(response.url, contentType, allowed));
  }

  const objectName =
    name ??
    [
      (directory ?? "").replace(/\/+$/, ""),
      `${Bun.randomUUIDv7()}.${extensionFor(contentType)}`,
    ]
      .filter(Boolean)
      .join("/");

  let size = headSize;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (headSize > 0) controller.enqueue(headBytes);
      if (ended) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      size += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const params: PutStreamParams = {
    name: objectName,
    bucket,
    body,
    contentType,
  };
  let stored: string;
  try {
    stored = driver.putStream
      ? await driver.putStream(params, { signal })
      : // A driver that implements the interface without extending
        // `FileStorageDriver`: buffer through the base class's default.
        await FileStorageDriver.prototype.putStream.call(driver, params, {
          signal,
        });
  } catch (error) {
    // A driver that failed before reading the body to its end must not keep
    // the download open until the timeout.
    await fail(error);
    throw error;
  }

  return { name: stored, contentType, size, url: response.url };
}

function concat(chunks: Uint8Array[], length: number) {
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
