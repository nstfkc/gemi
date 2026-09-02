import { describe, expect, test } from "vitest";

import type {
  ProviderCapabilities,
  ProviderStreamParams,
  ProviderToolSpec,
} from "../AgentProvider";
import type { AgentMessage } from "../types";
import { buildResponsesRequest, toResponsesInput, toResponsesTools } from "./request";

const FULL: ProviderCapabilities = {
  reasoning: true,
  structuredOutput: true,
  fileInput: true,
  parallelToolCalls: true,
  toolSearch: true,
};

const OLD: ProviderCapabilities = {
  reasoning: false,
  structuredOutput: true,
  fileInput: true,
  parallelToolCalls: true,
  toolSearch: false,
};

function message(partial: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">) {
  return { id: "m1", createdAt: "2026-01-01T00:00:00.000Z", ...partial } as AgentMessage;
}

function tool(partial: Partial<ProviderToolSpec> & Pick<ProviderToolSpec, "name">) {
  return {
    description: `does ${partial.name}`,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
    ...partial,
  } as ProviderToolSpec;
}

function build(params: Partial<ProviderStreamParams>, capabilities = FULL) {
  return buildResponsesRequest({ messages: [], ...params } as ProviderStreamParams, {
    model: "gpt-5.4",
    capabilities,
  });
}

describe("toResponsesInput()", () => {
  test("text and files become one input message per role", () => {
    const items = toResponsesInput(
      [
        message({
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "file", fileId: "file_1" },
          ],
        }),
        message({ role: "assistant", content: [{ type: "text", text: "on it" }] }),
      ],
      FULL,
    );

    expect(items).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look at this" },
          { type: "input_file", file_id: "file_1" },
        ],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
    ]);
  });

  test("a file is dropped when the model cannot read one", () => {
    const items = toResponsesInput(
      [message({ role: "user", content: [{ type: "file", fileId: "file_1" }] })],
      { ...OLD, fileInput: false },
    );
    expect(items).toEqual([]);
  });

  /**
   * Order within a message is the part that is easy to get wrong and expensive
   * to get wrong: the API validates call/output pairing positionally, so text
   * emitted after the call it preceded is a 400.
   */
  test("preserves the order of parts inside one message", () => {
    const items = toResponsesInput(
      [
        message({
          role: "assistant",
          content: [
            { type: "reasoning", id: "rs_1", text: "thinking" },
            { type: "text", text: "let me check" },
            { type: "tool-call", toolCallId: "call_1", name: "grep", input: { pattern: "x" } },
            {
              type: "tool-result",
              toolCallId: "call_1",
              name: "grep",
              status: "ok",
              output: { matches: [] },
            },
            { type: "text", text: "nothing found" },
          ],
        }),
      ],
      FULL,
    );

    expect(items.map((i) => i.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(items[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "grep",
      arguments: '{"pattern":"x"}',
    });
  });

  test("reasoning round-trips in its original shape", () => {
    const items = toResponsesInput(
      [
        message({
          role: "assistant",
          content: [{ type: "reasoning", id: "rs_9", text: "because" }],
        }),
      ],
      FULL,
    );
    expect(items).toEqual([
      { type: "reasoning", id: "rs_9", summary: [{ type: "summary_text", text: "because" }] },
    ]);
  });

  test("reasoning with no id is dropped rather than sent under an invented one", () => {
    const items = toResponsesInput(
      [message({ role: "assistant", content: [{ type: "reasoning", text: "orphan" }] })],
      FULL,
    );
    expect(items).toEqual([]);
  });

  test("a partial tool call is not sent, because it has no result and never will", () => {
    const items = toResponsesInput(
      [
        message({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              name: "grep",
              input: { p: 1 },
              partial: true,
            },
          ],
        }),
      ],
      FULL,
    );
    expect(items).toEqual([]);
  });

  /**
   * The bug this pins bricks a thread rather than failing a request: the
   * history is persisted, so an orphaned output is resent on every turn and
   * the conversation can never be continued. `stop()` produces exactly this
   * shape — a partial call, skipped, whose in-flight result was written down.
   */
  test("a partial call's result is dropped with it, not left as an orphan", () => {
    const items = toResponsesInput(
      [
        message({ role: "user", content: [{ type: "text", text: "refund it" }] }),
        message({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              name: "refund",
              input: { id: 7 },
              partial: true,
            },
            {
              type: "tool-result",
              toolCallId: "call_1",
              name: "refund",
              status: "denied",
              cause: "stopped",
            },
          ],
        }),
      ],
      FULL,
    );

    expect(items.map((i) => i.type)).toEqual(["message"]);
  });

  test("a duplicated result is sent once — a second output is a 400 too", () => {
    const items = toResponsesInput(
      [
        message({
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call_1", name: "grep", input: {} },
            { type: "tool-result", toolCallId: "call_1", name: "grep", status: "ok", output: "a" },
            { type: "tool-result", toolCallId: "call_1", name: "grep", status: "ok", output: "b" },
          ],
        }),
      ],
      FULL,
    );

    expect(items.map((i) => i.type)).toEqual(["function_call", "function_call_output"]);
    expect(items[1]!.output).toBe("a");
  });

  /**
   * The mirror image, and the same consequence: a crash between the call and
   * its result leaves a `function_call` the API will reject forever. Saying
   * "no result" is true, readable, and keeps the thread continuable.
   */
  test("a call whose result never arrived gets one, immediately after it", () => {
    const items = toResponsesInput(
      [
        message({
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call_1", name: "grep", input: {} },
            { type: "tool-call", toolCallId: "call_2", name: "read", input: {} },
            { type: "tool-result", toolCallId: "call_2", name: "read", status: "ok", output: "ok" },
          ],
        }),
      ],
      FULL,
    );

    expect(items).toEqual([
      { type: "function_call", call_id: "call_1", name: "grep", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "No result was recorded for this tool call. Assume it did not complete.",
      },
      { type: "function_call", call_id: "call_2", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_2", output: "ok" },
    ]);
  });

  test("an output whose call is only declared later is still an orphan", () => {
    const items = toResponsesInput(
      [
        message({
          role: "assistant",
          content: [
            { type: "tool-result", toolCallId: "call_1", name: "grep", status: "ok", output: "x" },
            { type: "tool-call", toolCallId: "call_1", name: "grep", input: {} },
          ],
        }),
      ],
      FULL,
    );

    // The call keeps a synthetic output rather than borrowing the one that
    // arrived before it: the API pairs positionally.
    expect(items.map((i) => [i.type, i.call_id])).toEqual([
      ["function_call", "call_1"],
      ["function_call_output", "call_1"],
    ]);
    expect(items[1]!.output).toContain("No result was recorded");
  });

  test("a structured output part goes back as assistant text", () => {
    const items = toResponsesInput(
      [
        message({
          role: "assistant",
          content: [{ type: "output", value: { sentiment: "positive" } }],
        }),
      ],
      FULL,
    );
    expect(items).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: '{"sentiment":"positive"}' }],
      },
    ]);
  });

  /**
   * The API rejects a `function_call` with no `function_call_output`, so a
   * denial cannot be expressed by leaving it out. What matters beyond that is
   * that the three outcomes read differently to the model.
   */
  describe("every tool call gets an output, including the ones that never ran", () => {
    /** Paired with its call, because that is the only way a result reaches the
     *  wire — an output on its own is dropped as an orphan. */
    function outputFor(part: any): string {
      const items = toResponsesInput(
        [
          message({
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: part.toolCallId, name: part.name, input: {} },
              part,
            ],
          }),
        ],
        FULL,
      );
      expect(items.map((i) => i.type)).toEqual(["function_call", "function_call_output"]);
      return String(items[1]!.output);
    }

    test("a refusal says the user declined", () => {
      const text = outputFor({
        type: "tool-result",
        toolCallId: "call_1",
        name: "charge",
        status: "denied",
        cause: "refused",
        reason: "too much",
      });
      expect(text).toContain("declined");
      expect(text).toContain("too much");
    });

    test("a stop says the run was stopped, not that the user said no", () => {
      const text = outputFor({
        type: "tool-result",
        toolCallId: "call_1",
        name: "charge",
        status: "denied",
        cause: "stopped",
      });
      expect(text).toContain("stopped");
      expect(text).not.toContain("declined");
    });

    test("a failure reads as a failure and carries the code", () => {
      const text = outputFor({
        type: "tool-result",
        toolCallId: "call_1",
        name: "charge",
        status: "error",
        error: { code: "tool_error", message: "card declined", retryable: false },
      });
      expect(text).toContain("failed");
      expect(text).toContain("tool_error");
      expect(text).toContain("card declined");
    });

    test("a string result is sent as itself rather than as a quoted JSON string", () => {
      expect(
        outputFor({
          type: "tool-result",
          toolCallId: "c",
          name: "cat",
          status: "ok",
          output: "hello",
        }),
      ).toBe("hello");
    });
  });
});

describe("toResponsesTools()", () => {
  const crm = {
    name: "crm",
    description: "Customer records",
    tools: [tool({ name: "listOrders", deferred: true }), tool({ name: "refundOrder" })],
  };

  test("namespaces survive, deferral maps to defer_loading, and tool_search is added", () => {
    expect(toResponsesTools([tool({ name: "bash" }), crm], FULL)).toEqual([
      {
        type: "function",
        name: "bash",
        description: "does bash",
        parameters: expect.anything(),
        strict: true,
      },
      {
        type: "namespace",
        name: "crm",
        description: "Customer records",
        tools: [
          {
            type: "function",
            name: "listOrders",
            description: "does listOrders",
            parameters: expect.anything(),
            strict: true,
            defer_loading: true,
          },
          {
            type: "function",
            name: "refundOrder",
            description: "does refundOrder",
            parameters: expect.anything(),
            strict: true,
          },
        ],
      },
      { type: "tool_search" },
    ]);
  });

  test("no tool_search entry when nothing is deferred — it would be a tool nothing can use", () => {
    const out = toResponsesTools([tool({ name: "bash" })], FULL);
    expect(out.some((t) => t.type === "tool_search")).toBe(false);
  });

  /**
   * The promise `capabilities.toolSearch` makes: without it the agent behaves
   * identically, it just costs more tokens.
   */
  test("without tool search, namespaces flatten and deferral is ignored", () => {
    expect(toResponsesTools([tool({ name: "bash" }), crm], OLD)).toEqual([
      {
        type: "function",
        name: "bash",
        description: "does bash",
        parameters: expect.anything(),
        strict: true,
      },
      {
        type: "function",
        name: "listOrders",
        description: "does listOrders",
        parameters: expect.anything(),
        strict: true,
      },
      {
        type: "function",
        name: "refundOrder",
        description: "does refundOrder",
        parameters: expect.anything(),
        strict: true,
      },
    ]);
  });
});

describe("buildResponsesRequest()", () => {
  test("the shape of a minimal streaming request", () => {
    expect(build({ systemPrompt: "be brief" })).toEqual({
      model: "gpt-5.4",
      input: [],
      stream: true,
      instructions: "be brief",
    });
  });

  test("output becomes a strict json_schema format", () => {
    const schema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    } as const;
    expect(build({ output: { name: "classification", schema } }).text).toEqual({
      format: { type: "json_schema", name: "classification", schema, strict: true },
    });
  });

  /**
   * The asymmetry with `reasoning` below is the point. Dropping a reasoning
   * effort costs quality; dropping an output schema costs the app its typed
   * result with no error anywhere to notice. So this one is sent regardless
   * and the API gets to say no.
   */
  test("output is sent even to a model we think has no structured output", () => {
    const schema = { type: "object", properties: {} } as const;
    const body = build({ output: { name: "c", schema } }, { ...FULL, structuredOutput: false });
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "c", schema, strict: true },
    });
  });

  test("reasoning asks for a summary, because otherwise the stream carries none", () => {
    expect(build({ reasoning: "high" }).reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("reasoning is dropped silently when the model has none", () => {
    expect(build({ reasoning: "high" }, OLD).reasoning).toBeUndefined();
  });

  test("parallel_tool_calls is only sent when it has to be turned off", () => {
    const tools = [tool({ name: "bash" })];
    expect(build({ tools }).parallel_tool_calls).toBeUndefined();
    expect(build({ tools }, { ...FULL, parallelToolCalls: false }).parallel_tool_calls).toBe(false);
  });

  test("an empty tool list is omitted rather than sent as []", () => {
    expect(build({ tools: [] }).tools).toBeUndefined();
  });

  test("sampling parameters ride along only when set", () => {
    expect(build({ temperature: 0.2, maxOutputTokens: 512 })).toMatchObject({
      temperature: 0.2,
      max_output_tokens: 512,
    });
    expect(build({}).temperature).toBeUndefined();
  });
});
