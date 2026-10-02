import { describe, expect, test } from "vitest";

import { HttpRequest } from "./HttpRequest";

describe("HttpRequest.signal (#659)", () => {
  test("is the incoming request's signal, so a client abort reaches the controller", () => {
    const controller = new AbortController();
    const req = new HttpRequest(
      new Request("https://example.test/api/slow", {
        signal: controller.signal,
      }),
      {},
    );
    expect(req.signal.aborted).toBe(false);
    controller.abort();
    expect(req.signal.aborted).toBe(true);
  });
});
