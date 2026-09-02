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
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_RESOURCE_NAME",
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

/**
 * Azure, rebuilt against the live API.
 *
 * Every URL asserted here was POSTed to a real resource before it was written
 * down; the measurements are in the `azureBase` comment in `AgentProvider.ts`.
 * What was there before — `{endpoint}/openai/deployments/{deployment}/responses`
 * with a dated api-version — 404s on every path, which is what a suite of
 * assertions written from the docs will happily agree with forever.
 */
describe("AzureOpenAIProvider", () => {
  const azure = (config: Record<string, unknown> = {}) =>
    AzureOpenAIProvider.model("gpt-5.4", {
      endpoint: "https://acme.openai.azure.com/",
      apiKey: "azure-key",
      ...config,
    });

  async function urlFor(config: Record<string, unknown> = {}): Promise<string> {
    const calls = stubFetch();
    await drain(azure(config).stream({ messages: HELLO }));
    return calls[0]!.url;
  }

  /**
   * NO DEPLOYMENT IN THE URL. The Responses API does not serve
   * `/openai/deployments/<name>/responses` at all — it is the Chat Completions
   * shape, and it 404s on both host spellings and both api-versions. The
   * deployment travels in the body's `model`, which is where the request
   * builder was already putting it.
   */
  test("posts to the v1 Responses path with the deployment in the body", async () => {
    const calls = stubFetch();
    await drain(azure().stream({ messages: HELLO }));

    expect(calls[0]!.url).toBe(
      "https://acme.openai.azure.com/openai/v1/responses?api-version=preview",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: "gpt-5.4" });
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe("azure-key");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  /**
   * THE BUG THIS REPLACED. `AZURE_OPENAI_ENDPOINT` is conventionally written
   * with `/openai` already on it — that is the spelling in the Azure portal and
   * in gemi's own `.env` — and the old code appended a second one, producing
   * `…/openai/openai/deployments/…`. So the documented way to configure the
   * provider was the one way that could not work.
   */
  test("an endpoint that already ends in /openai does not get a second one", async () => {
    for (const endpoint of [
      "https://acme.openai.azure.com",
      "https://acme.openai.azure.com/",
      "https://acme.openai.azure.com/openai",
      "https://acme.openai.azure.com/openai/",
      // Someone who copied a whole URL out of a working curl.
      "https://acme.openai.azure.com/openai/v1",
    ]) {
      expect(await urlFor({ endpoint }), endpoint).toBe(
        "https://acme.openai.azure.com/openai/v1/responses?api-version=preview",
      );
    }
  });

  /**
   * Both spellings resolve, and neither is rewritten into the other. Verified
   * live: `cognitiveservices.azure.com` and `openai.azure.com` answered
   * identically on every path tried, so the host was never the variable — and
   * only one of the two exists for a resource that was not created as
   * kind=OpenAI, which is why guessing at it would be worse than passing it
   * through.
   */
  test("both Azure host spellings are used as given", async () => {
    expect(await urlFor({ endpoint: "https://acme.cognitiveservices.azure.com" })).toBe(
      "https://acme.cognitiveservices.azure.com/openai/v1/responses?api-version=preview",
    );
    expect(await urlFor({ endpoint: "https://acme.openai.azure.com" })).toBe(
      "https://acme.openai.azure.com/openai/v1/responses?api-version=preview",
    );
  });

  /**
   * The app should not have to know any of the above. A resource name is the
   * one thing an Azure user always has, and it expands to the
   * `cognitiveservices` host: both work for a kind=OpenAI resource, only that
   * one works for an AI Foundry or multi-service resource, so it is right more
   * often. An app on the other one names its endpoint.
   */
  test("a bare resource name is enough, with no endpoint at all", async () => {
    expect(await urlFor({ endpoint: undefined, resourceName: "acme" })).toBe(
      "https://acme.cognitiveservices.azure.com/openai/v1/responses?api-version=preview",
    );
  });

  test("and it can come from the environment, under either variable name", async () => {
    vi.stubEnv("AZURE_RESOURCE_NAME", "acme");
    expect(await urlFor({ endpoint: undefined })).toBe(
      "https://acme.cognitiveservices.azure.com/openai/v1/responses?api-version=preview",
    );
    vi.stubEnv("AZURE_OPENAI_RESOURCE_NAME", "other");
    expect(await urlFor({ endpoint: undefined })).toContain("https://other.cognitiveservices");
  });

  test("an endpoint beats a resource name, because it is the more specific answer", async () => {
    vi.stubEnv("AZURE_RESOURCE_NAME", "ignored");
    expect(await urlFor()).toBe(
      "https://acme.openai.azure.com/openai/v1/responses?api-version=preview",
    );
  });

  test("a deployment named something else is an override, not a different method", async () => {
    const calls = stubFetch();
    await drain(azure({ deployment: "prod" }).stream({ messages: HELLO }));
    // It moved out of the URL, so this is now the only place it shows up.
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("prod");
    expect(calls[0]!.url).not.toContain("prod");
    // The API stays symmetrical: apps still name a model.
    expect(azure({ deployment: "prod" }).model).toBe("gpt-5.4");
  });

  /**
   * `preview` is not a floating "latest" — it names Azure's `/openai/v1`
   * surface, which is the OpenAI-shaped one gemi's request builder speaks, and
   * that surface takes no dated version: `api-version=2025-04-01-preview` on
   * `/openai/v1/responses` answers
   * `400 {"code":"BadRequest","message":"API version not supported"}`.
   */
  test("a dated api-version routes to the older path, so a pinned app keeps working", async () => {
    expect(await urlFor({ apiVersion: "2025-04-01-preview" })).toBe(
      "https://acme.openai.azure.com/openai/responses?api-version=2025-04-01-preview",
    );
    vi.stubEnv("AZURE_OPENAI_API_VERSION", "2026-01-01");
    expect(await urlFor()).toBe(
      "https://acme.openai.azure.com/openai/responses?api-version=2026-01-01",
    );
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

  test("uploads follow the same fork, and are resource-scoped either way", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ id: "assistant-file-1" })));
    await azure().upload(new File(["x"], "x.txt"));
    expect(calls[0]!.url).toBe(
      "https://acme.openai.azure.com/openai/v1/files?api-version=preview",
    );

    const dated = stubFetch(new Response(JSON.stringify({ id: "assistant-file-2" })));
    await azure({ apiVersion: "2025-04-01-preview" }).upload(new File(["x"], "x.txt"));
    expect(dated[0]!.url).toBe(
      "https://acme.openai.azure.com/openai/files?api-version=2025-04-01-preview",
    );
  });

  /**
   * Azure's extra array reaches the parser unchanged and changes nothing — see
   * `providers/recordings.test.ts` for why its mere presence must not mean
   * "filtered". This is the end-to-end half of that: a provider stream carrying
   * it still ends `stop`.
   */
  test("the content_filters Azure adds to every response are not an error", async () => {
    stubFetch(
      sse(
        [
          "response.created",
          {
            type: "response.created",
            response: { content_filters: [{ blocked: false, source_type: "prompt" }] },
          },
        ],
        ["response.output_text.delta", { type: "response.output_text.delta", delta: "hi" }],
        [
          "response.completed",
          {
            type: "response.completed",
            response: {
              content_filters: [{ blocked: false, source_type: "completion" }],
              usage: { input_tokens: 1, output_tokens: 2 },
            },
          },
        ],
      ),
    );

    const events = await drain(azure().stream({ messages: HELLO }));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  test("capabilities are read off the model, not off the deployment name", () => {
    expect(AzureOpenAIProvider.model("gpt-5.4", { deployment: "prod" }).capabilities.toolSearch)
      .toBe(true);
    expect(AzureOpenAIProvider.model("gpt-5.1", { deployment: "prod" }).capabilities.toolSearch)
      .toBe(false);
  });
});
