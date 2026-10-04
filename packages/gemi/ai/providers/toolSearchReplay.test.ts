process.env.SECRET ??= "tool-search-replay-test-secret";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { Agent, AgentTool, ToolNamespace } from "../Agent";
import type { ProviderCapabilities, ProviderEvent, ProviderStreamParams } from "../AgentProvider";
import { applyFrame, initialChatState } from "../client/reducer";
import { s } from "../Schema";
import type { AgentMessage, AgentStreamFrame, ToolCallPart } from "../types";
import { fakeProvider } from "./fakeProvider";
import { buildResponsesRequest, toResponsesInput } from "./request";
import { parseResponsesStream } from "./stream";

/**
 * #776: a namespaced call, and the tool search that loaded it, have to go back
 * to the API the way the model made them.
 *
 * Before the fix the call was replayed as a bare `function_call` (no
 * `namespace`) and the search pair was not replayed at all, so from step two
 * on the model read calls to top-level functions its tools did not list. In
 * kyte that made it loop on an unrelated tool until `max-steps`, three runs
 * out of three.
 *
 * Driven from the recorded stream (`__fixtures__/openai-tool-search.sse`,
 * gpt-5.4 searching a deferred `crm` namespace and calling `crm.getOrder`)
 * through a real `Agent`, so the parser, the run and the request builder are
 * all in the path, and asserted on the request body step two would send.
 */

const FULL: ProviderCapabilities = {
  reasoning: true,
  structuredOutput: true,
  fileInput: true,
  parallelToolCalls: true,
  toolSearch: true,
};

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

async function recordedStep(): Promise<ProviderEvent[]> {
  const raw = readFileSync(join(import.meta.dirname, "__fixtures__", "openai-tool-search.sse"), "utf8");
  const events: ProviderEvent[] = [];
  for await (const event of parseResponsesStream([raw])) events.push(event);
  return events;
}

function answer(text: string): ProviderEvent[] {
  return [
    { type: "text-delta", delta: text },
    { type: "finish", reason: "stop", usage: USAGE },
  ];
}

function crmAgent(provider: ReturnType<typeof fakeProvider>) {
  const listOrders = AgentTool.create({
    name: "listOrders",
    description: "List a customer's orders.",
    inputSchema: s.object({ customerId: s.string() }),
    outputSchema: s.object({ orderIds: s.array(s.string()) }),
    execute: async () => ({ orderIds: ["4417"] }),
  });
  const getOrder = AgentTool.create({
    name: "getOrder",
    description: "Fetch one order by id.",
    inputSchema: s.object({ orderId: s.string() }),
    outputSchema: s.object({ totalCents: s.number() }),
    execute: async () => ({ totalCents: 4200 }),
  });
  const crm = ToolNamespace.create({
    name: "crm",
    description: "Customer records, orders and refunds.",
    deferred: true,
    tools: [listOrders, getOrder],
  });
  return Agent.create({ name: "support", instructions: "Use crm.", provider, tools: [crm] });
}

function inputOf(params: ProviderStreamParams) {
  return buildResponsesRequest(params, { model: "gpt-5.4", capabilities: FULL }).input;
}

/** The items between the user's message and the answer: what the replay is about. */
function replayed(input: Record<string, any>[]) {
  return input.filter((item) => item.type !== "message");
}

const EXPECTED_REPLAY = [
  {
    type: "tool_search_call",
    call_id: null,
    execution: "server",
    status: "completed",
    // The query exactly as the recording has it.
    arguments: { paths: ["crm"] },
  },
  {
    type: "tool_search_output",
    call_id: null,
    execution: "server",
    status: "completed",
    tools: [
      {
        type: "namespace",
        name: "crm",
        description: "Customer records, orders and refunds.",
        tools: [
          expect.objectContaining({ type: "function", name: "listOrders", defer_loading: true }),
          expect.objectContaining({ type: "function", name: "getOrder", defer_loading: true }),
        ],
      },
    ],
  },
  {
    type: "function_call",
    call_id: "call_rgFEIYVjWtONGlzl1gTmy46Y",
    name: "getOrder",
    namespace: "crm",
    arguments: JSON.stringify({ orderId: "4417" }),
  },
  {
    type: "function_call_output",
    call_id: "call_rgFEIYVjWtONGlzl1gTmy46Y",
    output: JSON.stringify({ totalCents: 4200 }),
  },
];

describe("tool search replay (#776)", () => {
  test("step two's request carries the search pair and the namespaced call from step one", async () => {
    const provider = fakeProvider(await recordedStep(), answer("4200"));
    const result = await crmAgent(provider)
      .stream({ messages: [], turn: { text: "Total on order 4417?" } })
      .result();

    expect(result.finishReason).toBe("stop");
    expect(provider.calls).toHaveLength(2);
    expect(replayed(inputOf(provider.calls[1]!))).toEqual(EXPECTED_REPLAY);
  });

  test("the call part keeps the namespace and the search, and nothing else does", async () => {
    const provider = fakeProvider(await recordedStep(), answer("4200"));
    const result = await crmAgent(provider)
      .stream({ messages: [], turn: { text: "Total on order 4417?" } })
      .result();

    const calls = result.messages
      .flatMap((message) => message.content)
      .filter((part): part is ToolCallPart => part.type === "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "getOrder",
      namespace: "crm",
      toolSearches: [
        { namespaces: ["crm"], loaded: ["listOrders", "getOrder"], arguments: { paths: ["crm"] } },
      ],
    });
  });

  /**
   * A stored transcript is JSON: what a `ChatStore` keeps, what a stateless
   * client posts back, and what a nested run's messages become on its parent's
   * call part. The next RUN has to replay from that, not from the objects the
   * first run still held.
   */
  test("a later run replays them from the stored transcript", async () => {
    const first = fakeProvider(await recordedStep(), answer("4200"));
    const stored: AgentMessage[] = JSON.parse(
      JSON.stringify(
        (
          await crmAgent(first)
            .stream({ messages: [], turn: { text: "Total on order 4417?" } })
            .result()
        ).messages,
      ),
    );

    const second = fakeProvider(answer("Still 4200."));
    await crmAgent(second)
      .stream({ messages: stored, turn: { text: "And again?" } })
      .result();

    expect(replayed(inputOf(second.calls[0]!))).toEqual(EXPECTED_REPLAY);
  });

  /**
   * The client's copy is built from frames, not from the server's objects, and
   * in stateless mode it is the history the next turn is sent. The part comes
   * over on the `tool-call` frame whole, so the reducer's copy has to replay
   * the same way.
   */
  test("the client's transcript, rebuilt from frames, replays the same", async () => {
    const provider = fakeProvider(await recordedStep(), answer("4200"));
    const run = crmAgent(provider).stream({ messages: [], turn: { text: "Total on order 4417?" } });
    const frames: AgentStreamFrame[] = [];
    for await (const frame of run.frames()) frames.push(frame);
    const state = frames.reduce((acc, frame) => applyFrame(acc, frame), initialChatState());

    const second = fakeProvider(answer("Still 4200."));
    await crmAgent(second)
      .stream({ messages: JSON.parse(JSON.stringify(state.messages)), turn: { text: "Again?" } })
      .result();

    expect(replayed(inputOf(second.calls[0]!))).toEqual(EXPECTED_REPLAY);
  });
});

describe("toResponsesInput(), namespaced calls (#776)", () => {
  const tools = [
    {
      name: "crm",
      description: "Customer records",
      tools: [
        {
          name: "getOrder",
          description: "does getOrder",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
          strict: true,
          deferred: true,
        },
      ],
    },
  ];

  function history(part: Partial<ToolCallPart>): AgentMessage[] {
    return [
      {
        id: "m1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:00.000Z",
        content: [
          { type: "tool-call", toolCallId: "c1", name: "getOrder", input: {}, ...part } as ToolCallPart,
          { type: "tool-result", toolCallId: "c1", name: "getOrder", status: "ok", output: 1 },
        ],
      },
    ];
  }

  test("a namespaced call goes back with its namespace", () => {
    const items = toResponsesInput(history({ namespace: "crm" }), FULL, tools);
    expect(items[0]).toEqual({
      type: "function_call",
      call_id: "c1",
      name: "getOrder",
      namespace: "crm",
      arguments: "{}",
    });
  });

  /**
   * Without tool search the tools are sent flat, so there is no namespace for
   * the call to name; and an agent whose namespace is gone since the call was
   * made has none either. Naming it anyway would be a call into nothing.
   */
  test("the namespace is dropped when the request has no such namespace", () => {
    const flat = toResponsesInput(history({ namespace: "crm" }), { ...FULL, toolSearch: false }, tools);
    expect(flat[0]).not.toHaveProperty("namespace");
    const gone = toResponsesInput(history({ namespace: "billing" }), FULL, tools);
    expect(gone[0]).not.toHaveProperty("namespace");
  });

  test("a search is not replayed without tool search, or when it would load nothing", () => {
    const search = { namespaces: ["crm"], loaded: ["getOrder"], arguments: { paths: ["crm"] } };
    const types = (items: Record<string, unknown>[]) => items.map((item) => item.type);

    expect(
      types(toResponsesInput(history({ toolSearches: [search] }), { ...FULL, toolSearch: false }, tools)),
    ).toEqual(["function_call", "function_call_output"]);
    expect(
      types(
        toResponsesInput(
          history({ toolSearches: [{ namespaces: ["billing"], loaded: ["refund"] }] }),
          FULL,
          tools,
        ),
      ),
    ).toEqual(["function_call", "function_call_output"]);
    expect(types(toResponsesInput(history({ toolSearches: [search] }), FULL, tools))).toEqual([
      "tool_search_call",
      "tool_search_output",
      "function_call",
      "function_call_output",
    ]);
  });

  /** Stateless mode: the field came back from the browser and may be anything. */
  test("a malformed search record does not throw", () => {
    const items = toResponsesInput(
      history({ toolSearches: [null, { namespaces: "crm" }] as any }),
      FULL,
      tools,
    );
    expect(items.map((item) => item.type)).toEqual(["function_call", "function_call_output"]);
    expect(() =>
      toResponsesInput(history({ toolSearches: "nope" as any }), FULL, tools),
    ).not.toThrow();
  });
});
