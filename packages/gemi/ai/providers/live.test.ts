import { afterEach, describe, expect, test, vi } from "vitest";

import { requestWithRetry } from "./http";
import { LiveModelCallRefusedError, assertLiveFetch, assertLiveWebSocket } from "./live";

/** Real model calls from a test process (#1342). */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const options = { maxRetries: 2, timeoutMs: 1_000 };

describe("under vitest", () => {
  test("a built-in provider's request is refused before it is sent, and not retried", async () => {
    const error = await requestWithRetry("https://api.example.com/v1/responses", {}, options).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LiveModelCallRefusedError);
    expect((error as Error).message).toContain("https://api.example.com");
    expect((error as Error).message).toContain("GEMI_AI_LIVE=1");
  });

  test("a socket to a provider is refused", () => {
    expect(() => assertLiveWebSocket("wss://api.example.com/v1/realtime")).toThrow(
      LiveModelCallRefusedError,
    );
  });

  test("GEMI_AI_LIVE=1 lets real calls through", () => {
    vi.stubEnv("GEMI_AI_LIVE", "1");
    expect(() => assertLiveFetch("https://api.example.com/v1/responses")).not.toThrow();
    expect(() => assertLiveWebSocket("wss://api.example.com/v1/realtime")).not.toThrow();
  });

  test("an injected fetch reaches no network and is let through", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const response = await requestWithRetry("https://api.example.com/v1/responses", {}, {
      ...options,
      fetchImpl,
    });
    expect(await response.text()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("a stubbed global fetch or WebSocket is let through", async () => {
    const fake = vi.fn(async () => new Response("stubbed"));
    vi.stubGlobal("fetch", fake);
    const response = await requestWithRetry("https://api.example.com/v1/responses", {}, options);
    expect(await response.text()).toBe("stubbed");

    vi.stubGlobal("WebSocket", class {});
    expect(() => assertLiveWebSocket("wss://api.example.com/v1/realtime")).not.toThrow();
  });

  test("this machine is let through: a test server or a local model", () => {
    for (const url of [
      "http://127.0.0.1:4010/v1/responses",
      "http://localhost:11434/api/chat",
      "http://api.localhost/v1",
      "http://[::1]:8080/v1",
    ]) {
      expect(() => assertLiveFetch(url)).not.toThrow();
    }
    expect(() => assertLiveFetch("http://10.0.0.5/v1")).toThrow(LiveModelCallRefusedError);
  });
});

describe("outside a test process", () => {
  test("nothing is refused", () => {
    vi.stubEnv("VITEST", undefined);
    expect(() => assertLiveFetch("https://api.example.com/v1/responses")).not.toThrow();
    expect(() => assertLiveWebSocket("wss://api.example.com/v1/realtime")).not.toThrow();
  });
});
