import { loadLazy, type LazyModule } from "./lazyModule";
import type { FileRPC } from "./rpc";
import type { UrlParser } from "./types";

/**
 * The paths `fetchBlob` and `fetchText` take: the app's file routes
 * (`this.stream(...)` and `this.file(...)`), or any path while `FileRPC` is
 * empty — an app without file routes, or a program without the app's types.
 */
export type FilePath = FilePathOf<FileRPC>;

/** `FilePath` over a given table, for tests. @internal */
export type FilePathOf<T> = [keyof T] extends [never] ? string : keyof T & string;

export type FetchFileOptions<P extends string> = {
  /** The path's `:params`, substituted as `useQuery` does. */
  params?: Partial<UrlParser<P>>;
  /** The query string. `null` and `undefined` values are left out. */
  search?:
    | Record<string, string | number | boolean | null | undefined>
    | URLSearchParams;
  /** Aborts the request; the returned promise then rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Anything else `fetch` takes (headers, `cache`, `credentials`). Always a `GET`. */
  init?: Omit<RequestInit, "method" | "body" | "signal">;
};

// `options` is required, with `params`, when the path has a param of its own.
/** @internal */
export type FetchFileArgs<P extends string> =
  {} extends UrlParser<P>
    ? [options?: FetchFileOptions<P>]
    : [options: FetchFileOptions<P> & { params: UrlParser<P> }];

interface Fetched {
  /**
   * The file name the server gave in `Content-Disposition` (`filename*`
   * first, then `filename`), or `null` when it gave none.
   */
  filename: string | null;
  /** The response, for its headers and status. Its body has been read. */
  response: Response;
}

export interface FetchedBlob extends Fetched {
  blob: Blob;
}

export interface FetchedText extends Fetched {
  text: string;
}

// The request itself, loaded on the first call (#915): an app's bundler puts
// whatever `gemi/client` reaches statically in every route's entry chunk.
const request: LazyModule<typeof import("./fetchFileRequest")> = {
  current: null,
  load: () => import("./fetchFileRequest.js"),
};

/**
 * Downloads a file route's body as a `Blob`.
 *
 * ```ts
 * const { blob, filename } = await fetchBlob("/pages/:pageId/post/image", {
 *   params: { pageId },
 *   search: { format: "png" },
 * });
 * ```
 *
 * A non-2xx rejects with a `QueryError` (`status`, the JSON `body` or `null`,
 * `retryAfter`), the error `useQuery` throws, so `mutationErrorList(error)`
 * reads its message. A network failure rejects with the browser's `TypeError`,
 * an abort with its `AbortError`.
 *
 * The request code loads on the first call (#915), so a route that never
 * downloads a file carries none of it; a failed load rejects as a network
 * failure does.
 */
export async function fetchBlob<P extends FilePath>(
  path: P,
  ...args: FetchFileArgs<P>
): Promise<FetchedBlob> {
  return (await loadLazy(request)).fetchFile(path, args[0], "blob") as Promise<FetchedBlob>;
}

/** `fetchBlob`, with the body read as text. */
export async function fetchText<P extends FilePath>(
  path: P,
  ...args: FetchFileArgs<P>
): Promise<FetchedText> {
  return (await loadLazy(request)).fetchFile(path, args[0], "text") as Promise<FetchedText>;
}
