import { describe, expect, test } from "vitest";

import {
  createStreamResponse,
  createUnsatisfiableResponse,
  type StreamOutput,
} from "./createStreamResponse";
import { parseRangeHeader } from "./range";

const TEN = "0123456789";

const serve = (output: StreamOutput, header?: string, method?: string) =>
  createStreamResponse(output, {
    range: parseRangeHeader(header ?? null),
    method,
  });

const blob = (content = TEN, type = "text/plain") =>
  new Blob([content], { type });

function streamOf(content: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

describe("createStreamResponse() without a Range", () => {
  test("serves the whole blob as a 200", async () => {
    const res = await serve(blob());

    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    // The media type, not the whole header. `createStreamResponse` passes
    // `blob.type` through untouched, so this assertion was really about what
    // the *runtime's* Blob constructor stores — and Bun changed it: as of
    // 1.3.14 `new Blob([…], { type: "text/plain" })` reports
    // `text/plain;charset=utf-8`, where it used to report `text/plain`.
    //
    // Passing the charset through is right, so the expectation moved rather
    // than the code. Matched on the media type so a future parameter change
    // does not break it a third time; the fallback case below still asserts an
    // exact string, because there the value is ours rather than the runtime's.
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain\b/);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(await res.text()).toBe(TEN);
  });

  test("falls back to an octet stream content type", async () => {
    const res = await serve(blob(TEN, ""));
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });
});

describe("createStreamResponse() with a satisfiable Range", () => {
  test("slices a blob and reports the window", async () => {
    const res = await serve(blob(), "bytes=2-5");

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  test("resolves a suffix range", async () => {
    const res = await serve(blob(), "bytes=-3");

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(await res.text()).toBe("789");
  });

  test("serves an open ended range to the last byte", async () => {
    const res = await serve(blob(), "bytes=7-");

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(await res.text()).toBe("789");
  });

  test("clamps an end past the last byte", async () => {
    const res = await serve(blob(), "bytes=5-999999");

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 5-9/10");
    expect(await res.text()).toBe("56789");
  });

  test("answers `bytes=0-` with a 206 spanning the whole object", async () => {
    // The case that proves `partial` cannot be derived from the offsets: this
    // window covers the entire file, and it is still a partial response.
    const res = await serve(blob(), "bytes=0-");

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-9/10");
    expect(await res.text()).toBe(TEN);
  });
});

describe("createStreamResponse() with an unsatisfiable Range", () => {
  test("returns a bodyless 416 with the current size", async () => {
    const res = await serve(blob(), "bytes=999-");

    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await res.text()).toBe("");
  });

  test("treats any range over an empty object as unsatisfiable", async () => {
    const res = await serve(blob(""), "bytes=0-10");

    expect(res.status).toBe(416);
    // The naive path would have formatted `bytes 0--1/0` here.
    expect(res.headers.get("Content-Range")).toBe("bytes */0");
    expect(res.headers.get("Content-Range")).not.toContain("--");
  });

  test("rejects a zero length suffix", async () => {
    const res = await serve(blob(), "bytes=-0");
    expect(res.status).toBe(416);
  });

  test("createUnsatisfiableResponse builds the same shape", async () => {
    const res = createUnsatisfiableResponse(42);
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */42");
    expect(res.headers.get("Content-Length")).toBe("0");
  });
});

describe("createStreamResponse() with an ignorable Range", () => {
  test("serves a 200 when the header is malformed", async () => {
    const res = await serve(blob(), "bytes=nonsense");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(await res.text()).toBe(TEN);
  });

  test("serves a 200 for a multi range request", async () => {
    // We never emit multipart/byteranges, so the range is ignored entirely.
    const res = await serve(blob(), "bytes=0-1,4-5");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(TEN);
  });
});

describe("createStreamResponse() with a driver ReadResult", () => {
  test("trusts a driver that already applied the range", async () => {
    const res = await serve(
      {
        body: streamOf("2345"),
        start: 2,
        end: 5,
        total: 10,
        partial: true,
        type: "video/mp4",
        etag: '"abc"',
      },
      "bytes=2-5",
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(res.headers.get("ETag")).toBe('"abc"');
    expect(await res.text()).toBe("2345");
  });

  test("serves a 200 when a driver ignored the range on an unsized stream", async () => {
    // RFC 7233 §4.1 permits ignoring a Range. Better a full 200 than a 206
    // whose Content-Range does not describe the bytes actually sent.
    const res = await serve(
      {
        body: streamOf(TEN),
        start: 0,
        end: 9,
        total: 10,
        partial: false,
        type: "text/plain",
      },
      "bytes=2-5",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(await res.text()).toBe(TEN);
  });

  test("sets Last-Modified from the driver", async () => {
    const lastModified = new Date("2026-01-02T03:04:05Z");
    const res = await serve({
      body: blob(),
      start: 0,
      end: 9,
      total: 10,
      partial: false,
      type: "text/plain",
      lastModified,
    });

    expect(res.headers.get("Last-Modified")).toBe(lastModified.toUTCString());
  });
});

describe("createStreamResponse() output forms", () => {
  test("passes a Response through untouched", async () => {
    const original = new Response("hi", { status: 418 });
    expect(await serve(original, "bytes=0-1")).toBe(original);
  });

  test("returns a 404 for a nullish output", async () => {
    expect((await serve(null)).status).toBe(404);
    expect((await serve(undefined)).status).toBe(404);
  });

  test("returns a 404 when a lazy file does not exist", async () => {
    const missing = Object.assign(new Blob(["x"]), {
      exists: async () => false,
    });
    expect((await serve(missing)).status).toBe(404);
  });

  test("sets Content-Disposition from a descriptor", async () => {
    const res = await serve({
      file: blob(),
      name: "report.txt",
      download: true,
    });

    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="report.txt"; filename*=UTF-8''report.txt`,
    );
  });

  test("lets descriptor headers win over the computed ones", async () => {
    const res = await serve({
      file: blob(),
      headers: { "Cache-Control": "public, max-age=3600" },
    });

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  test("ranges a descriptor carrying a sized blob", async () => {
    const res = await serve({ file: blob(), type: "video/mp4" }, "bytes=1-3");

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 1-3/10");
    expect(await res.text()).toBe("123");
  });
});

describe("createStreamResponse() for HEAD", () => {
  test("keeps the headers but drops the body", async () => {
    const res = await serve(blob(), undefined, "HEAD");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.body).toBeNull();
  });

  test("still reports the window for a ranged HEAD", async () => {
    const res = await serve(blob(), "bytes=2-5", "HEAD");

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(res.body).toBeNull();
  });

  test("cancels a stream body rather than leaking it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(TEN));
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    await serve(
      { body, start: 0, end: 9, total: 10, partial: false, type: "text/plain" },
      undefined,
      "HEAD",
    );

    expect(cancelled).toBe(true);
  });
});
