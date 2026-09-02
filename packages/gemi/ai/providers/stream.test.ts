import { describe, expect, test } from "vitest";

import type { ProviderEvent } from "../AgentProvider";
import { parseResponsesStream, sseMessages, toUsage } from "./stream";

/**
 * The fixtures in THIS file are written by hand, and stay that way on purpose.
 * They cover shapes that are awkward or impossible to provoke on demand — a
 * frame split mid-token, a `[DONE]` from a gateway that then never closes, a
 * socket that just stops, a refusal item — and a hand-written one is readable
 * enough that a reviewer can see which case it is.
 *
 * What used to be here and is not any more is guesswork about shapes the API
 * sends every day. Those moved to `recordings.test.ts`, which drives the same
 * parser from real captured traffic in `__fixtures__/`. Two of the guesses
 * were wrong; see `toolSearchReport` in `stream.ts`.
 */
function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function collect(
  chunks: string[],
  options?: { structuredOutput?: boolean },
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of parseResponsesStream(chunks, options)) out.push(event);
  return out;
}

const USAGE = {
  input_tokens: 120,
  output_tokens: 30,
  total_tokens: 150,
  input_tokens_details: { cached_tokens: 64 },
  output_tokens_details: { reasoning_tokens: 12 },
};

const TEXT_STREAM = [
  frame("response.created", { type: "response.created", response: { id: "resp_1" } }),
  frame("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "msg_1", type: "message", role: "assistant" },
  }),
  frame("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: "msg_1",
    delta: "Hello",
  }),
  frame("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: "msg_1",
    delta: " there",
  }),
  frame("response.completed", {
    type: "response.completed",
    response: { id: "resp_1", status: "completed", usage: USAGE },
  }),
];

const TOOL_CALL_STREAM = [
  frame("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "fc_item_1",
      type: "function_call",
      call_id: "call_abc",
      name: "grep",
      arguments: "",
    },
  }),
  frame("response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: "fc_item_1",
    delta: '{"pattern"',
  }),
  frame("response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: "fc_item_1",
    delta: ':"todo"}',
  }),
  frame("response.function_call_arguments.done", {
    type: "response.function_call_arguments.done",
    item_id: "fc_item_1",
    arguments: '{"pattern":"todo"}',
  }),
  frame("response.output_item.done", {
    type: "response.output_item.done",
    item: {
      id: "fc_item_1",
      type: "function_call",
      call_id: "call_abc",
      name: "grep",
      arguments: '{"pattern":"todo"}',
    },
  }),
  frame("response.completed", {
    type: "response.completed",
    response: { status: "completed", usage: USAGE },
  }),
];

describe("sseMessages()", () => {
  test("ignores keepalive comments and joins multi-line data", async () => {
    const raw = [
      ": ping\n\n",
      "event: response.output_text.delta\n",
      'data: {"type":"response.output_text.delta",\n',
      'data:  "delta":"hi"}\n',
      "\n",
    ];
    const messages = [];
    for await (const message of sseMessages(raw)) messages.push(message);

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!.data)).toEqual({
      type: "response.output_text.delta",
      delta: "hi",
    });
  });

  test("survives CRLF line endings and a missing final blank line", async () => {
    const raw = ['event: error\r\ndata: {"type":"error","message":"boom"}\r\n'];
    const messages = [];
    for await (const message of sseMessages(raw)) messages.push(message);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.event).toBe("error");
    expect(JSON.parse(messages[0]!.data).message).toBe("boom");
  });

  test("carries the id field, which is how reattachment gets its cursor", async () => {
    const raw = ["id: 42\nevent: ping\ndata: {}\n\n"];
    const messages = [];
    for await (const message of sseMessages(raw)) messages.push(message);
    expect(messages[0]!.id).toBe("42");
  });
});

describe("parseResponsesStream()", () => {
  test("text deltas and a terminal event with usage", async () => {
    expect(await collect(TEXT_STREAM)).toEqual([
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: " there" },
      {
        type: "finish",
        reason: "stop",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          reasoningTokens: 12,
          cachedInputTokens: 64,
        },
      },
    ]);
  });

  test("the same text deltas become output deltas when an output schema was asked for", async () => {
    const events = await collect(TEXT_STREAM, { structuredOutput: true });
    expect(events.slice(0, 2)).toEqual([
      { type: "output-delta", delta: "Hello" },
      { type: "output-delta", delta: " there" },
    ]);
  });

  test("reasoning deltas carry the item id they belong to", async () => {
    const events = await collect([
      frame("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        delta: "Checking the ",
      }),
      frame("response.reasoning_text.delta", {
        type: "response.reasoning_text.delta",
        item_id: "rs_1",
        delta: "invoice",
      }),
      frame("response.completed", { type: "response.completed", response: { usage: USAGE } }),
    ]);

    expect(events.slice(0, 2)).toEqual([
      { type: "reasoning-delta", delta: "Checking the ", id: "rs_1" },
      { type: "reasoning-delta", delta: "invoice", id: "rs_1" },
    ]);
  });

  test("argument deltas are keyed to the call id, and completion is reported once", async () => {
    const events = await collect(TOOL_CALL_STREAM);
    expect(events).toEqual([
      { type: "tool-call-delta", toolCallId: "call_abc", name: "grep", argsDelta: '{"pattern"' },
      { type: "tool-call-delta", toolCallId: "call_abc", name: "grep", argsDelta: ':"todo"}' },
      { type: "tool-call", toolCallId: "call_abc", name: "grep", args: '{"pattern":"todo"}' },
      { type: "finish", reason: "stop", usage: expect.anything() },
    ]);
  });

  test("a call whose arguments never got a done event still completes", async () => {
    const events = await collect([
      TOOL_CALL_STREAM[0]!,
      TOOL_CALL_STREAM[1]!,
      TOOL_CALL_STREAM[4]!,
      TOOL_CALL_STREAM[5]!,
    ]);

    expect(events.filter((e) => e.type === "tool-call")).toEqual([
      { type: "tool-call", toolCallId: "call_abc", name: "grep", args: '{"pattern":"todo"}' },
    ]);
  });

  /**
   * The linked case: the output item names the call item's id, so the two key
   * the same and the second is dropped. The live API sends no such link — see
   * `recordings.test.ts`, where the collapse falls to a different mechanism.
   */
  test("the tool_search call and its output collapse into one event", async () => {
    const events = await collect([
      frame("response.output_item.added", {
        type: "response.output_item.added",
        item: { id: "ts_1", type: "tool_search_call", status: "in_progress" },
      }),
      frame("response.output_item.done", {
        type: "response.output_item.done",
        item: {
          id: "ts_out_1",
          type: "tool_search_output",
          tool_search_call_id: "ts_1",
          results: [{ name: "listOrders" }, { name: "refundOrder" }],
        },
      }),
      frame("response.output_item.done", {
        type: "response.output_item.done",
        item: {
          id: "ts_1",
          type: "tool_search_call",
          results: [{ name: "listOrders" }, { name: "refundOrder" }],
        },
      }),
      frame("response.completed", { type: "response.completed", response: { usage: USAGE } }),
    ]);

    expect(events.filter((e) => e.type === "tool-search")).toEqual([
      // No namespaces: this shape lists functions at the top level, which is
      // the older result form and still what a gateway may send.
      { type: "tool-search", loaded: ["listOrders", "refundOrder"], namespaces: [] },
    ]);
  });

  test("an incomplete response hitting the output cap finishes as length", async () => {
    const events = await collect([
      frame("response.incomplete", {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" }, usage: USAGE },
      }),
    ]);
    expect(events).toEqual([{ type: "finish", reason: "length", usage: expect.anything() }]);
  });

  test("a mid-stream error becomes an error event and a finish", async () => {
    const events = await collect([
      frame("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_1",
        delta: "partial",
      }),
      frame("error", {
        type: "error",
        error: { code: "rate_limit_exceeded", message: "Slow down." },
      }),
    ]);

    expect(events).toEqual([
      { type: "text-delta", delta: "partial" },
      {
        type: "error",
        error: { code: "rate_limited", message: "Slow down.", retryable: true },
      },
      { type: "finish", reason: "error", usage: expect.anything() },
    ]);
  });

  test("a refusal is reported as content_filtered rather than as text", async () => {
    const events = await collect([
      frame("response.refusal.done", {
        type: "response.refusal.done",
        refusal: "I can't help with that.",
      }),
      frame("response.completed", { type: "response.completed", response: { usage: USAGE } }),
    ]);

    expect(events[0]).toEqual({
      type: "error",
      error: {
        code: "content_filtered",
        message: "I can't help with that.",
        retryable: false,
      },
    });
  });

  test("a stream that just stops is an error, not a clean finish", async () => {
    const events = await collect([TEXT_STREAM[2]!]);
    expect(events).toEqual([
      { type: "text-delta", delta: "Hello" },
      {
        type: "error",
        error: {
          code: "provider_error",
          message: "The provider stream ended without a terminal event.",
          retryable: true,
        },
      },
      {
        type: "finish",
        reason: "error",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });

  test("unparseable frames are skipped without abandoning the stream", async () => {
    const events = await collect([
      "event: response.output_text.delta\ndata: {not json\n\n",
      ...TEXT_STREAM.slice(2),
    ]);
    expect(events[0]).toEqual({ type: "text-delta", delta: "Hello" });
  });

  /**
   * `[DONE]` is a Chat Completions habit that OpenAI-compatible gateways bring
   * to the Responses stream. After a terminal event it is redundant, and the
   * parser has already returned before reading it.
   */
  test("[DONE] after a terminal event changes nothing", async () => {
    const events = await collect([...TEXT_STREAM, "data: [DONE]\n\n"]);
    expect(events.at(-1)).toEqual({
      type: "finish",
      reason: "stop",
      usage: expect.objectContaining({ inputTokens: 120 }),
    });
  });

  /**
   * On its own it is not a clean ending: it says the socket is over, not what
   * the model did, and there is no usage and no status behind it. Reporting a
   * stop there would tell the agent an answer finished that may have been cut
   * in half — so it lands on the same retryable error as a dropped connection.
   */
  test("[DONE] without a terminal event is still an unfinished stream", async () => {
    const events = await collect([TEXT_STREAM[2]!, "data: [DONE]\n\n"]);
    expect(events).toEqual([
      { type: "text-delta", delta: "Hello" },
      {
        type: "error",
        error: {
          code: "provider_error",
          message: "The provider stream ended without a terminal event.",
          retryable: true,
        },
      },
      {
        type: "finish",
        reason: "error",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });

  /**
   * What the `[DONE]` branch is actually for, and the only thing that fails
   * without it: a gateway that marks the end and then holds the connection
   * open. Treating the frame as unparseable JSON and continuing would leave
   * the generator waiting on a chunk that never comes — this test hangs rather
   * than fails if that guard goes.
   */
  test("[DONE] releases a source that never closes", async () => {
    async function* neverEnds() {
      yield TEXT_STREAM[2]!;
      yield "data: [DONE]\n\n";
      await new Promise(() => {});
    }
    const out: ProviderEvent[] = [];
    for await (const event of parseResponsesStream(neverEnds())) out.push(event);
    expect(out.at(-1)!.type).toBe("finish");
  });

  /**
   * The one test that would have caught every SSE bug this parser has ever had:
   * the same fixture, one byte at a time, must produce the same events. Chunk
   * boundaries land inside field names, inside JSON strings and between the CR
   * and the LF, and none of that is visible when a fixture arrives whole.
   */
  test("byte-at-a-time chunking produces an identical event sequence", async () => {
    for (const fixture of [TEXT_STREAM, TOOL_CALL_STREAM]) {
      const whole = await collect(fixture);
      const bytes = fixture.join("").split("");
      expect(await collect(bytes)).toEqual(whole);
    }
  });
});

describe("toUsage()", () => {
  test("omits the optional counters the response did not report", () => {
    expect(toUsage({ input_tokens: 5, output_tokens: 7 })).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
    });
  });
});
