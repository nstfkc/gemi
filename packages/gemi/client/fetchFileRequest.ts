import { applyParams } from "../utils/applyParams";
import type { FetchedBlob, FetchedText, FetchFileOptions } from "./fetchFile";
import { QueryError } from "./QueryError";
import { parseRetryAfter } from "./retryPolicy";

// What `fetchBlob` and `fetchText` in `./fetchFile` load on their first call
// (#915).

type RequestOptions = Omit<FetchFileOptions<string>, "params"> & {
  params?: Record<string, string | number | undefined>;
};

/**
 * `fetchBlob` / `fetchText` once loaded: the `GET`, a `QueryError` for a
 * non-2xx, and the body read `as` a blob or text.
 */
export async function fetchFile(
  path: string,
  // The caller's `FetchFileOptions<P>`, checked against its path there.
  options: object | undefined,
  as: "blob" | "text",
): Promise<FetchedBlob | FetchedText> {
  const response = await request(path, options as RequestOptions);
  const body = as === "blob" ? { blob: await response.blob() } : { text: await response.text() };
  return { ...body, filename: filenameOf(response), response } as FetchedBlob | FetchedText;
}

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
