import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AzureOpenAIProvider, OpenAIProvider, type ProviderEvent } from "./AgentProvider";
import type { AgentMessage } from "./types";

/**
 * Nothing here touches the network: `fetch` is replaced for the duration of the
 * test and the SSE body is a string. What is being checked is the half of each
 * class that is not shared — the URL it posts to, the credential it attaches,
 * and when it reads that credential.
 */
const realFetch = globalThis.fetch;

// A developer's shell is a shared fixture nobody wrote down. These are the
// variables the providers read, and a machine that happens to export one turns
// a URL assertion into a mystery failure on one laptop.
beforeEach(() => {
  for (const name of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_API_VERSION",
  ]) {
    vi.stubEnv(name, undefined as unknown as string);
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

function sse(...frames: [string, unknown][]): string {
  return frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

const COMPLETED = sse(
  ["response.output_text.delta", { type: "response.output_text.delta", delta: "hi" }],
  [
    "response.completed",
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
  ],
);

function stubFetch(body: string | Response = COMPLETED) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return typeof body === "string" ? new Response(body) : body.clone();
  }) as unknown as typeof fetch;
  return calls;
}

async function drain(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const HELLO: AgentMessage[] = [
  { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "2026-01-01" },
];

describe("OpenAIProvider", () => {
  test("posts a streaming Responses request and translates the answer", async () => {
    const calls = stubFetch();
    const provider = OpenAIProvider.model("gpt-5.4", { apiKey: "sk-test" });

    const events = await drain(provider.stream({ messages: HELLO, systemPrompt: "be brief" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      model: "gpt-5.4",
      stream: true,
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(events).toEqual([
      { type: "text-delta", delta: "hi" },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ]);
  });

  test("capabilities come off the model id", () => {
    expect(OpenAIProvider.model("gpt-4o").capabilities.reasoning).toBe(false);
    expect(OpenAIProvider.model("gpt-5.4").capabilities.reasoning).toBe(true);
  });

  test("the api key falls back to the environment, so a model name is the whole config", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-from-env");
    const calls = stubFetch();
    await drain(OpenAIProvider.model("gpt-5.4").stream({ messages: HELLO }));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-from-env");
  });

  test("a baseURL override survives a trailing slash", async () => {
    const calls = stubFetch();
    await drain(
      OpenAIProvider.model("gpt-5.4", { apiKey: "k", baseURL: "https://gw.example/v1/" }).stream({
        messages: HELLO,
      }),
    );
    expect(calls[0]!.url).toBe("https://gw.example/v1/responses");
  });

  /**
   * A failure after the request is accepted cannot be an exception — the
   * caller is iterating, and the deltas it already has are text the user has
   * already read.
   */
  test("a rejected request comes back as an error event and a finish", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 }),
    );
    const events = await drain(
      OpenAIProvider.model("gpt-5.4", { apiKey: "bad", maxRetries: 0 }).stream({ messages: HELLO }),
    );

    expect(events).toEqual([
      {
        type: "error",
        error: { code: "provider_error", message: "Incorrect API key", retryable: false },
      },
      {
        type: "finish",
        reason: "error",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });

  test("an aborted run finishes as aborted, and reports no error of its own", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async () => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;

    const events = await drain(
      OpenAIProvider.model("gpt-5.4", { apiKey: "k" }).stream({
        messages: HELLO,
        signal: controller.signal,
      }),
    );
    expect(events).toEqual([
      {
        type: "finish",
        reason: "aborted",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });

  test("upload posts multipart and returns the file id a FilePart carries", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ id: "file_123" })));
    const fileId = await OpenAIProvider.model("gpt-5.4", { apiKey: "k" }).upload(
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    );

    expect(fileId).toBe("file_123");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/files");
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    expect((calls[0]!.init.body as FormData).get("purpose")).toBe("user_data");
    // Setting content-type by hand would drop the multipart boundary.
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  test("normalizeError is on the instance, so an app never touches the provider's error shape", () => {
    const provider = OpenAIProvider.model("gpt-5.4");
    const normalized = provider.normalizeError(new TypeError("fetch failed"));
    expect(normalized).toMatchObject({ code: "provider_error", retryable: true });
  });
});

describe("AzureOpenAIProvider", () => {
  const azure = (config: Record<string, unknown> = {}) =>
    AzureOpenAIProvider.model("gpt-5.4", {
      endpoint: "https://acme.openai.azure.com/",
      apiKey: "azure-key",
      ...config,
    });

  test("the deployment is in the URL and the api-version is pinned", async () => {
    const calls = stubFetch();
    await drain(azure().stream({ messages: HELLO }));

    expect(calls[0]!.url).toBe(
      "https://acme.openai.azure.com/openai/deployments/gpt-5.4/responses?api-version=2025-04-01-preview",
    );
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe("azure-key");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("a deployment named something else is an override, not a different method", async () => {
    const calls = stubFetch();
    await drain(azure({ deployment: "prod" }).stream({ messages: HELLO }));
    expect(calls[0]!.url).toContain("/openai/deployments/prod/responses");
    // The API stays symmetrical: apps still name a model.
    expect(azure({ deployment: "prod" }).model).toBe("gpt-5.4");
  });

  /**
   * The reason `getToken` is a function: an Entra token minted at boot has
   * expired by the time a long conversation reaches step nine, and that shows
   * up as a random 401 in the middle of a working feature.
   */
  test("getToken is called once per request, not once per provider", async () => {
    const calls = stubFetch();
    let issued = 0;
    const provider = azure({ getToken: async () => `token-${++issued}` });

    await drain(provider.stream({ messages: HELLO }));
    await drain(provider.stream({ messages: HELLO }));

    expect(issued).toBe(2);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer token-2");
  });

  test("uploads are resource-scoped, not deployment-scoped", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ id: "assistant-file-1" })));
    await azure().upload(new File(["x"], "x.txt"));
    expect(calls[0]!.url).toBe(
      "https://acme.openai.azure.com/openai/files?api-version=2025-04-01-preview",
    );
  });

  test("an app that needs a newer api-version names it", async () => {
    const calls = stubFetch();
    await drain(azure({ apiVersion: "2026-01-01" }).stream({ messages: HELLO }));
    expect(calls[0]!.url).toContain("api-version=2026-01-01");
  });
});
