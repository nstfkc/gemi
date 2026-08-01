import { afterEach, describe, expect, test, vi } from "vitest";
import {
  readRoutePayload,
  readSettledRoutePayload,
} from "./readRoutePayload";

/** A Response whose body streams the given chunks, hand-cranked. */
function streamedResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readRoutePayload", () => {
  test("resolves with the envelope before later lines arrive, then drains payloads", async () => {
    const { response, write, close } = streamedResponse();
    const payloads: any[] = [];

    write(`{"data":{"/a":{}},"prefetchedData":{}}\n`);
    const envelope = await readRoutePayload(response, (p) => payloads.push(p));

    expect(envelope).toEqual({ data: { "/a": {} }, prefetchedData: {} });
    expect(payloads).toEqual([]);

    write(`["/metrics","",{"signups":412}]\n`);
    write(`["/products","page=2",{"rows":[]}]\n`);
    close();
    await vi.waitFor(() => expect(payloads).toHaveLength(2));

    expect(payloads).toEqual([
      ["/metrics", "", { signups: 412 }],
      ["/products", "page=2", { rows: [] }],
    ]);
  });

  test("a chunk boundary splitting a line does not corrupt parsing", async () => {
    const { response, write, close } = streamedResponse();
    const payloads: any[] = [];

    write(`{"ok":`);
    write(`true}\n["/x","",`);
    const envelope = await readRoutePayload(response, (p) => payloads.push(p));
    expect(envelope).toEqual({ ok: true });

    write(`{"v":1}]\n`);
    close();
    await vi.waitFor(() => expect(payloads).toEqual([["/x", "", { v: 1 }]]));
  });

  test("a plain single-JSON body with no trailing newline parses as the envelope", async () => {
    const { response, write, close } = streamedResponse();
    write(`{"data":{"legacy":true}}`);
    close();

    expect(await readRoutePayload(response)).toEqual({
      data: { legacy: true },
    });
  });

  test("falls back to .json() for responses without a readable body", async () => {
    const fake = { json: async () => ({ mocked: true }) } as Response;
    expect(await readRoutePayload(fake)).toEqual({ mocked: true });
  });

  test("an unparseable body resolves null instead of throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, write, close } = streamedResponse();
    write("not json at all");
    close();

    expect(await readRoutePayload(response)).toBeNull();
  });
});

describe("readSettledRoutePayload", () => {
  test("merges every streamed payload into the envelope's prefetchedData", async () => {
    const { response, write, close } = streamedResponse();
    write(`{"data":{},"prefetchedData":{"/early":{"":{"e":1}}}}\n`);
    write(`["/late","page=2",{"rows":[1]}]\n`);
    write(`["/late","page=3",null]\n`);
    close();

    const payload = await readSettledRoutePayload(response);
    expect(payload.prefetchedData).toEqual({
      "/early": { "": { e: 1 } },
      "/late": { "page=2": { rows: [1] }, "page=3": null },
    });
  });

  test("passes a plain JSON body through unchanged", async () => {
    const { response, write, close } = streamedResponse();
    write(`{"data":{},"prefetchedData":{"/only":{"":1}}}`);
    close();

    const payload = await readSettledRoutePayload(response);
    expect(payload.prefetchedData).toEqual({ "/only": { "": 1 } });
  });
});
