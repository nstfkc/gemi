import { applyParams } from "../utils/applyParams";
import { QueryError } from "./QueryError";
import { parseRetryAfter } from "./retryPolicy";
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
 */
export async function fetchBlob<P extends FilePath>(
  path: P,
  ...args: FetchFileArgs<P>
): Promise<FetchedBlob> {
  const response = await request(path, args[0] as RequestOptions);
  return { blob: await response.blob(), filename: filenameOf(response), response };
}

/** `fetchBlob`, with the body read as text. */
export async function fetchText<P extends FilePath>(
  path: P,
  ...args: FetchFileArgs<P>
): Promise<FetchedText> {
  const response = await request(path, args[0] as RequestOptions);
  return { text: await response.text(), filename: filenameOf(response), response };
}

type RequestOptions = Omit<FetchFileOptions<string>, "params"> & {
  params?: Record<string, string | number | undefined>;
};

async function request(path: string, options: RequestOptions = {}) {
  const { params = {}, search, signal, init } = options;
  const url = applyParams(path, params);
  const query = searchString(search);
  const response = await fetch(`/api${url}${query ? `?${query}` : ""}`, {
    ...init,
    method: "GET",
    signal,
  });
  if (!response.ok) {
    // An error body that is not JSON (a proxy's HTML 502) is still that status.
    const body = await response.json().catch(() => null);
    throw new QueryError(
      url,
      query,
      response.status,
      body,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  return response;
}

function searchString(search: FetchFileOptions<string>["search"]) {
  if (!search) return "";
  if (search instanceof URLSearchParams) return search.toString();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== null && value !== undefined) params.append(key, String(value));
  }
  return params.toString();
}

/**
 * The file name in a `Content-Disposition` header: the RFC 5987
 * `filename*=UTF-8''...` form when present and decodable, else `filename`.
 *
 * @internal Exported for tests.
 */
export function filenameOf(response: Response): string | null {
  const header = response.headers.get("content-disposition");
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      // A malformed escape: fall back to the plain form.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  if (!plain) return null;
  const name = plain[1] !== undefined ? plain[1].replace(/\\(.)/g, "$1") : plain[2].trim();
  return name || null;
}
