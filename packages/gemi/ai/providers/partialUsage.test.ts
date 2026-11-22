import { describe, expect, test } from "vitest";

import { Agent } from "../Agent";
import { FallbackProvider } from "../FallbackProvider";
import { generate } from "../generate";
import { s } from "../Schema";
import { AnthropicProvider, OpenAIProvider, type AgentProvider, type ProviderEvent } from "../AgentProvider";
import { RecordingProvider, type Recording } from "../testing";
import type { FetchLike } from "./http";

/**
 * #1353: what a call used reaches the consumer when the call doesn't end
 * normally: cut, broken halfway, retried, or stopped.
 */

const frame = (payload: Record<string, unknown>) =>
  `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;

const MESSAGE_START = frame({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-x", usage: { input_tokens: 10, output_tokens: 1 } },
});
const TEXT =
  frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Writing it now." } });
const DELTA_USAGE = frame({ type: "message_delta", delta: {}, usage: { output_tokens: 7 } });

/** A 200 whose body sends `frames` one per pull, then ends, breaks the socket, or hangs. */
function body(frames: string[], end: "close" | "drop" | "hang" = "close") {
  const encoder = new TextEncoder();
  const queue = [...frames];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(encoder.encode(next));
      else if (end === "drop") controller.error(new TypeError("The socket connection was closed unexpectedly."));
      else if (end === "close") controller.close();
      else return new Promise(() => {});
    },
  });
}

function withFetch<P extends AgentProvider>(provider: P, bodies: Array<() => ReadableStream<Uint8Array>>): P {
  let count = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    const stream = bodies[Math.min(count++, bodies.length - 1)]!();
    init?.signal?.addEventListener("abort", () => void stream.cancel().catch(() => {}));
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const endpoint = (provider as any).endpoint.bind(provider);
  (provider as any).endpoint = () => ({ ...endpoint(), fetchImpl, sleep: async () => {}, random: () => 0 });
  return provider;
}

async function events(provider: AgentProvider, signal?: AbortSignal) {
  const seen: ProviderEvent[] = [];
  for await (const event of provider.stream({ messages: [], ...(signal ? { signal } : {}) })) seen.push(event);
  return seen;
}

const claude = (bodies: Array<() => ReadableStream<Uint8Array>>, maxRetries = 0, model = "claude-sonnet-4-6") =>
  withFetch(new AnthropicProvider(model, { apiKey: "k", maxRetries }), bodies);

/** Runs an agent until `ready` says so, then stops it. */
async function stopped(provider: AgentProvider, ready: () => boolean) {
  const stream = Agent.create({ name: "writer", provider }).stream({ messages: [], turn: { text: "go" } });
  const reading = (async () => {
    for await (const _event of stream) {
      // drained
    }
  })();
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await stream.stop();
  await reading;
  return stream.result();
}

describe("Anthropic", () => {
  test("a stream broken after some output reports that output's tokens, on the error and the finish", async () => {
    const seen = await events(claude([() => body([MESSAGE_START, TEXT, DELTA_USAGE], "drop")]));
    const used = { inputTokens: 10, outputTokens: 7 };
    expect(seen.find((event) => event.type === "error")).toMatchObject({ usage: used });
    expect(seen.at(-1)).toMatchObject({ type: "finish", reason: "error", usage: used });
  });

  test("usage events report the count as the stream says it, before the finish replaces it", async () => {
    const seen = await events(
      claude([() => body([MESSAGE_START, TEXT, DELTA_USAGE, frame({ type: "message_stop" })])]),
    );
    const usages = seen.filter((event) => event.type === "usage");
    expect(usages.map((event) => (event as { usage: { outputTokens: number } }).usage.outputTokens)).toEqual([1, 7]);
    expect(seen.at(-1)).toMatchObject({ type: "finish", usage: { outputTokens: 7 } });
  });

  test("a retried attempt's usage is on the retry event, and counted once in the finish", async () => {
    const seen = await events(
      claude(
        [
          () => body([MESSAGE_START], "drop"),
          () => body([MESSAGE_START, TEXT, DELTA_USAGE, frame({ type: "message_stop" })]),
        ],
        1,
      ),
    );
    const retry = seen.findIndex((event) => event.type === "retry");
    expect(seen[retry]).toMatchObject({ usage: { inputTokens: 10, outputTokens: 1 } });
    // Right after it, the call's total so far, for a stop during the wait.
    expect(seen[retry + 1]).toMatchObject({ type: "usage", usage: { inputTokens: 10, outputTokens: 1 } });
    // The dropped attempt's 10 + 1, and the second's 10 + 7.
    expect(seen.at(-1)).toMatchObject({ type: "finish", usage: { inputTokens: 20, outputTokens: 8 } });
  });

  test("a stopped run is billed what the call used so far", async () => {
    const provider = claude([() => body([MESSAGE_START, TEXT, DELTA_USAGE], "hang")]);
    const stream = Agent.create({ name: "writer", provider }).stream({ messages: [], turn: { text: "go" } });
    for await (const event of stream) {
      if (event.type === "text-delta") break;
    }
    // Let the delta's usage arrive before the stop.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stream.stop();
    const result = await stream.result();
    expect(result.finishReason).toBe("aborted");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 7 });
    expect(result.messages.at(-1)!.usage).toMatchObject({ inputTokens: 10, outputTokens: 7 });
  });
});

describe("stopped before the first content", () => {
  test("a stop right after message_start bills the input", async () => {
    let started = false;
    const provider = claude([
      () => {
        started = true;
        return body([MESSAGE_START], "hang");
      },
    ]);
    const result = await stopped(provider, () => started);
    expect(result.finishReason).toBe("aborted");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 1 });
  });

  test("a FallbackProvider's usage includes the legs it fell back from, each metered at its own model", async () => {
    let second = false;
    const first = claude([() => body([MESSAGE_START], "drop")], 0, "claude-sonnet-4-6");
    const backup = claude(
      [
        () => {
          second = true;
          return body([MESSAGE_START], "hang");
        },
      ],
      0,
      "claude-opus-5-5",
    );
    const provider = new FallbackProvider([{ provider: first }, { provider: backup }]);
    const result = await stopped(provider, () => second);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 2 });
    expect(result.metered?.byModel["claude-sonnet-4-6"]?.usage).toMatchObject({ inputTokens: 10 });
    expect(result.metered?.byModel["claude-opus-5-5"]?.usage).toMatchObject({ inputTokens: 10 });
  });

  test("a stopped generate() bills what its call used", async () => {
    const controller = new AbortController();
    const provider = claude([() => body([MESSAGE_START], "hang")]);
    const answer = generate({ provider, output: s.object({ a: s.string() }), prompt: "x", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const result = await answer;
    expect(result.ok).toBe(false);
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 1 });
  });
});

describe("OpenAI", () => {
  const CREATED = frame({ type: "response.created", response: { model: "gpt-5" } });
  const TEXT_DELTA = frame({ type: "response.output_text.delta", delta: "Writing" });
  const openai = (bodies: Array<() => ReadableStream<Uint8Array>>) =>
    withFetch(new OpenAIProvider("gpt-5", { apiKey: "k", maxRetries: 0 }), bodies);

  test("a response cut at the output limit passes its usage through", async () => {
    const seen = await events(
      openai([
        () =>
          body([
            CREATED,
            TEXT_DELTA,
            frame({
              type: "response.incomplete",
              response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 50, total_tokens: 55 } },
            }),
          ]),
      ]),
    );
    expect(seen.at(-1)).toMatchObject({ type: "finish", usage: { inputTokens: 5, outputTokens: 50 } });
  });

  test("a failed response passes its usage through", async () => {
    const seen = await events(
      openai([
        () =>
          body([
            CREATED,
            TEXT_DELTA,
            frame({
              type: "response.failed",
              response: { error: { code: "server_error", message: "boom" }, usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
            }),
          ]),
      ]),
    );
    expect(seen.at(-1)).toMatchObject({ type: "finish", reason: "error", usage: { inputTokens: 5, outputTokens: 3 } });
  });
});

describe("recordings", () => {
  test("a recording made before the usage event (none in its calls) replays as it did", async () => {
    const live = claude([() => body([MESSAGE_START, TEXT, DELTA_USAGE, frame({ type: "message_stop" })])]);
    const recorder = RecordingProvider.record(live);
    await Agent.create({ name: "old", provider: recorder }).stream({ messages: [], turn: { text: "hi" } }).result();
    const recorded = recorder.recording();
    // A recording made now holds the usage events.
    expect(recorded.calls[0]!.events.some((event) => event.type === "usage")).toBe(true);
    // One made before them: the same calls without the events.
    const old: Recording = {
      ...recorded,
      calls: recorded.calls.map((call) => ({ ...call, events: call.events.filter((event) => event.type !== "usage") })),
    };
    for (const recording of [recorded, old]) {
      const result = await Agent.create({ name: "old", provider: RecordingProvider.replay(recording) })
        .stream({ messages: [], turn: { text: "hi" } })
        .result();
      expect(result.finishReason).toBe("stop");
      expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 7 });
    }
  });
});
