import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchBlob, fetchText } from "./fetchFile";
import { filenameOf } from "./fetchFileRequest";
import { mutationErrorList } from "./MutationError";
import { QueryError } from "./QueryError";
import { isRetryableQueryError } from "./retryPolicy";

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBlob", () => {
  test("builds the url from params and search, and reads the body as a Blob", async () => {
    const fetchMock = stubFetch(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": `attachment; filename="post.png"; filename*=UTF-8''p%C3%B6st.png`,
        },
      }),
    );

    const { blob, filename, response } = await fetchBlob("/pages/:pageId/post/image", {
      params: { pageId: "p 1" },
      search: { format: "png", scale: 2, skip: undefined, none: null },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/pages/p 1/post/image?format=png&scale=2");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(blob.size).toBe(3);
    expect(blob.type).toBe("image/png");
    expect(filename).toBe("pöst.png");
    expect(response.status).toBe(200);
  });

  test("passes init and the signal through, and keeps the method a GET", async () => {
    const fetchMock = stubFetch(new Response("x"));
    const controller = new AbortController();

    await fetchBlob("/file", {
      signal: controller.signal,
      search: new URLSearchParams({ a: "1" }),
      init: { cache: "no-store", headers: { "X-Test": "1" }, method: "POST" } as RequestInit,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/file?a=1");
    expect(init).toMatchObject({ cache: "no-store", headers: { "X-Test": "1" }, method: "GET" });
    expect(init?.signal).toBe(controller.signal);
  });

  test("a non-2xx rejects with a QueryError carrying the JSON body", async () => {
    stubFetch(
      Response.json(
        { error: { kind: "validation_error", messages: { format: ["Unknown format"] } } },
        { status: 400 },
      ),
    );

    const error = await fetchBlob("/pages/:pageId/post/image", {
      params: { pageId: "p1" },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(QueryError);
    expect(error.status).toBe(400);
    expect(error.path).toBe("/pages/p1/post/image");
    expect(mutationErrorList(error, "Failed")).toEqual(["Unknown format"]);
  });

  test("a non-JSON error body is null, and Retry-After is read", async () => {
    stubFetch(
      new Response("<html>busy</html>", { status: 503, headers: { "Retry-After": "2" } }),
    );

    const error = await fetchBlob("/file").catch((e) => e);

    expect(error).toBeInstanceOf(QueryError);
    expect(error.body).toBeNull();
    expect(error.retryAfter).toBe(2000);
    expect(isRetryableQueryError(error)).toBe(true);
    expect(mutationErrorList(error, "Failed")).toEqual(["Failed"]);
  });

  test("a network failure rejects with fetch's own error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchBlob("/file")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("fetchText", () => {
  test("reads the body as text", async () => {
    stubFetch(
      new Response("a,b\n1,2\n", {
        headers: { "Content-Disposition": 'attachment; filename="report.csv"' },
      }),
    );

    const { text, filename } = await fetchText("/exports/report.csv");

    expect(text).toBe("a,b\n1,2\n");
    expect(filename).toBe("report.csv");
  });
});

describe("filenameOf", () => {
  const of = (header?: string) =>
    filenameOf(new Response(null, header ? { headers: { "Content-Disposition": header } } : {}));

  test("reads each form gemi and others send", () => {
    expect(of()).toBeNull();
    expect(of("inline")).toBeNull();
    expect(of('inline; filename="a b.pdf"')).toBe("a b.pdf");
    expect(of("attachment; filename=plain.txt")).toBe("plain.txt");
    expect(of('attachment; filename="say \\"hi\\".txt"')).toBe('say "hi".txt');
    expect(of("attachment; filename*=UTF-8''%E2%82%AC.txt")).toBe("€.txt");
  });

  test("falls back to filename when filename* is malformed", () => {
    expect(of(`attachment; filename="safe.txt"; filename*=UTF-8''%E2%82`)).toBe("safe.txt");
  });
});
