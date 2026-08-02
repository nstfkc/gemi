import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";

import {
  compressResponse,
  isCompressible,
  negotiateEncoding,
  parseAcceptEncoding,
} from "./compression";

const HTML = `<!doctype html><html><head><title>gemi</title></head><body>${"<div>hello</div>".repeat(200)}</body></html>`;

function htmlResponse(
  body: BodyInit | null = HTML,
  init: ResponseInit & { headers?: Record<string, string> } = {},
) {
  const { headers, ...rest } = init;
  return new Response(body, {
    ...rest,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

/** Streams the body in several chunks, the way a streamed SSR render does. */
function chunkedHtml(content = HTML, chunks = 4) {
  const bytes = new TextEncoder().encode(content);
  const size = Math.ceil(bytes.length / chunks);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) {
        controller.enqueue(bytes.subarray(offset, offset + size));
      }
      controller.close();
    },
  });
}

async function decode(res: Response) {
  const encoded = Buffer.from(await res.arrayBuffer());
  switch (res.headers.get("Content-Encoding")) {
    case "br":
      return brotliDecompressSync(encoded).toString();
    case "gzip":
      return gunzipSync(encoded).toString();
    default:
      return encoded.toString();
  }
}

const get = (acceptEncoding?: string) =>
  new Request("https://example.com/", {
    headers: acceptEncoding === undefined ? {} : { "Accept-Encoding": acceptEncoding },
  });

describe("parseAcceptEncoding()", () => {
  test("distinguishes an absent header from an empty one", () => {
    expect(parseAcceptEncoding(null)).toBeNull();
    expect(parseAcceptEncoding(undefined)).toBeNull();
    expect(parseAcceptEncoding("")).toEqual(new Map());
  });

  test("parses codings and q-values, case insensitively", () => {
    expect(parseAcceptEncoding("GZIP, br;q=0.8, *;q=0.1")).toEqual(
      new Map([
        ["gzip", 1],
        ["br", 0.8],
        ["*", 0.1],
      ]),
    );
  });

  test("tolerates whitespace and accept-ext parameters", () => {
    expect(parseAcceptEncoding("  br ; foo=bar ; q=0.5  ")).toEqual(new Map([["br", 0.5]]));
  });

  test("treats a malformed q-value as unqualified rather than dropping the coding", () => {
    expect(parseAcceptEncoding("gzip;q=high")).toEqual(new Map([["gzip", 1]]));
    expect(parseAcceptEncoding("gzip;q=2")).toEqual(new Map([["gzip", 1]]));
  });

  test("keeps q=0, which is a refusal and not an absence", () => {
    expect(parseAcceptEncoding("gzip;q=0")).toEqual(new Map([["gzip", 0]]));
  });
});

describe("negotiateEncoding()", () => {
  test("falls back to identity when the client says nothing", () => {
    expect(negotiateEncoding(null)).toBeNull();
    expect(negotiateEncoding("")).toBeNull();
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding("zstd, compress")).toBeNull();
  });

  test("picks what the client offers", () => {
    expect(negotiateEncoding("gzip")).toBe("gzip");
    expect(negotiateEncoding("br")).toBe("br");
  });

  test("breaks q-value ties on server preference, not client order", () => {
    expect(negotiateEncoding("gzip, br")).toBe("br");
    expect(negotiateEncoding("br, gzip")).toBe("br");
  });

  test("honours a higher q-value over the server preference", () => {
    expect(negotiateEncoding("gzip, br;q=0.5")).toBe("gzip");
  });

  test("treats q=0 as a refusal", () => {
    expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip;q=0")).toBeNull();
  });

  test("applies the wildcard only to codings the client did not name", () => {
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("br;q=0, *")).toBe("gzip");
    expect(negotiateEncoding("*;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("*;q=0")).toBeNull();
  });
});

describe("isCompressible()", () => {
  test("accepts a streamed HTML response", () => {
    expect(isCompressible("GET", htmlResponse())).toBe(true);
  });

  test("accepts the SSR 404, which is still an HTML document", () => {
    expect(isCompressible("GET", htmlResponse(HTML, { status: 404 }))).toBe(true);
  });

  test("leaves everything that isn't HTML alone", () => {
    const json = new Response("{}", {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    expect(isCompressible("GET", json)).toBe(false);
    expect(isCompressible("GET", new Response(HTML))).toBe(false);
    expect(
      isCompressible("GET", new Response("x", { headers: { "Content-Type": "text/html+evil" } })),
    ).toBe(false);
  });

  test("skips HEAD, which has no body to describe", () => {
    expect(isCompressible("HEAD", htmlResponse())).toBe(false);
  });

  test("skips bodyless and partial statuses", () => {
    expect(isCompressible("GET", htmlResponse(null, { status: 204 }))).toBe(false);
    expect(isCompressible("GET", htmlResponse(null, { status: 304 }))).toBe(false);
    expect(isCompressible("GET", htmlResponse(HTML, { status: 206 }))).toBe(false);
  });

  test("skips a range response even if the status was left at 200", () => {
    expect(
      isCompressible("GET", htmlResponse(HTML, { headers: { "Content-Range": "bytes 0-9/100" } })),
    ).toBe(false);
  });

  test("never re-encodes an already encoded body", () => {
    expect(
      isCompressible("GET", htmlResponse(HTML, { headers: { "Content-Encoding": "gzip" } })),
    ).toBe(false);
    // `identity` is the one value that means "not encoded".
    expect(
      isCompressible("GET", htmlResponse(HTML, { headers: { "Content-Encoding": "identity" } })),
    ).toBe(true);
  });

  test("honours Cache-Control: no-transform", () => {
    expect(
      isCompressible(
        "GET",
        htmlResponse(HTML, { headers: { "Cache-Control": "public, no-transform" } }),
      ),
    ).toBe(false);
    // Token match — a directive that merely contains the word does not count.
    expect(
      isCompressible("GET", htmlResponse(HTML, { headers: { "Cache-Control": "x-no-transform" } })),
    ).toBe(true);
  });

  test("skips a declared body too small to be worth encoding", () => {
    expect(
      isCompressible("GET", htmlResponse("<p>hi</p>", { headers: { "Content-Length": "9" } })),
    ).toBe(false);
    // A streamed response declares no length, so the threshold cannot apply —
    // which is the normal case for an SSR render.
    expect(isCompressible("GET", htmlResponse(chunkedHtml("<p>hi</p>", 1)))).toBe(true);
  });
});

describe("compressResponse()", () => {
  test("encodes a streamed HTML body to exactly the same bytes", async () => {
    const res = compressResponse(get("br, gzip"), htmlResponse(chunkedHtml()));

    expect(res.headers.get("Content-Encoding")).toBe("br");
    expect(await decode(res)).toBe(HTML);
  });

  test("produces the same document under gzip", async () => {
    const res = compressResponse(get("gzip"), htmlResponse(chunkedHtml()));

    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(await decode(res)).toBe(HTML);
  });

  test("actually shrinks the payload", async () => {
    const raw = new TextEncoder().encode(HTML).byteLength;
    for (const encoding of ["br", "gzip"]) {
      const res = compressResponse(get(encoding), htmlResponse(chunkedHtml()));
      const encoded = (await res.arrayBuffer()).byteLength;
      expect(encoded).toBeLessThan(raw / 2);
    }
  });

  test("drops a Content-Length that described the identity body", async () => {
    const res = compressResponse(
      get("gzip"),
      htmlResponse(HTML, { headers: { "Content-Length": String(HTML.length) } }),
    );

    expect(res.headers.get("Content-Length")).toBeNull();
    expect(await decode(res)).toBe(HTML);
  });

  test("preserves status, statusText and the other headers", async () => {
    const source = htmlResponse(chunkedHtml(), {
      status: 404,
      statusText: "Not Found",
      headers: { "Cache-Control": "public, max-age=60", "X-Gemi": "1" },
    });
    source.headers.append("Set-Cookie", "session_id=a; HttpOnly");
    source.headers.append("Set-Cookie", "csrf_token=b; HttpOnly");

    const res = compressResponse(get("br"), source);

    expect(res.status).toBe(404);
    expect(res.statusText).toBe("Not Found");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("X-Gemi")).toBe("1");
    expect(res.headers.getSetCookie()).toEqual([
      "session_id=a; HttpOnly",
      "csrf_token=b; HttpOnly",
    ]);
    expect(await decode(res)).toBe(HTML);
  });

  test("marks HTML as varying by Accept-Encoding even when it sends identity", async () => {
    const res = compressResponse(get(), htmlResponse(chunkedHtml()));

    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    expect(await res.text()).toBe(HTML);
  });

  test("adds Accept-Encoding to an existing Vary without duplicating it", () => {
    const varyOnHeader = compressResponse(
      get("gzip"),
      htmlResponse(chunkedHtml(), { headers: { Vary: "x-gemi-partial-render" } }),
    );
    expect(varyOnHeader.headers.get("Vary")).toBe("x-gemi-partial-render, Accept-Encoding");

    const alreadyVaries = compressResponse(
      get("gzip"),
      htmlResponse(chunkedHtml(), { headers: { Vary: "accept-encoding" } }),
    );
    expect(alreadyVaries.headers.get("Vary")).toBe("accept-encoding");

    const varyAll = compressResponse(
      get("gzip"),
      htmlResponse(chunkedHtml(), { headers: { Vary: "*" } }),
    );
    expect(varyAll.headers.get("Vary")).toBe("*");
  });

  test("returns non-HTML responses untouched, down to the identity of the object", async () => {
    const json = new Response(JSON.stringify({ data: 1 }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

    const res = compressResponse(get("br, gzip"), json);

    expect(res).toBe(json);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
    expect(await res.json()).toEqual({ data: 1 });
  });

  test("leaves an already encoded HTML body exactly as it was", () => {
    const encoded = htmlResponse(chunkedHtml(), { headers: { "Content-Encoding": "gzip" } });

    expect(compressResponse(get("br, gzip"), encoded)).toBe(encoded);
  });
});
