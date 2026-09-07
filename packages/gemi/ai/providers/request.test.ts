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

  /**
   * There are two ids now — the provider's `fileId` and gemi's `attachmentId` —
   * and this is the field that only ever takes the first. Left alone the wrong
   * one goes to the vendor as a file it has never heard of, mid-conversation
   * (which error, exactly, is not measured — see the guard's comment).
   */
  test("a gemi attachment id in FilePart.fileId is caught here, not by the vendor", () => {
    expect(() =>
      toResponsesInput(
        [message({ role: "user", content: [{ type: "file", fileId: "gemi_att_abc" }] })],
        FULL,
      ),
    ).toThrow(/attachment id/);
  });

  /**
   * The other half of the same guard, and the one a prefix check silently misses:
   * a storage-only upload has no provider id at all, so a client that spreads the
   * upload answer into a `FilePart` builds `fileId: undefined`. Without this,
   * `file_id: undefined` is what reaches the vendor.
   */
  test("an empty FilePart.fileId is caught too, which is what a storage-only upload builds", () => {
    expect(() =>
      toResponsesInput(
        [message({ role: "user", content: [{ type: "file", fileId: undefined as any }] })],
        FULL,
      ),
    ).toThrow(/FilePart.fileId is empty/);
  });

  test("a file is dropped when the model cannot read one", () => {
    const items = toResponsesInput(
      [message({ role: "user", content: [{ type: "file", fileId: "file_1" }] })],
      { ...OLD, fileInput: false },
    );
    expect(items).toEqual([]);
  });

  /**
   * The block an attachment lands in, which the API validates rather than
   * tolerates: an image sent as `input_file` and a document sent as
   * `input_image` are both 400s, and a 400 on a part that lives in persisted
   * history is a 400 on every subsequent turn. See `fileContent` in
   * `request.ts` for what was measured.
   */
  describe("a file part picks its content block", () => {
    const blocks = (part: Record<string, unknown>) =>
      (toResponsesInput([message({ role: "user", content: [part as any] })], FULL)[0]?.content ??
        []) as Record<string, unknown>[];

    test("an image goes to input_image", () => {
      expect(
        blocks({ type: "file", fileId: "file_1", name: "photo.png", mimeType: "image/png" }),
      ).toEqual([{ type: "input_image", file_id: "file_1" }]);
    });

    test("a pdf goes to input_file", () => {
      expect(
        blocks({
          type: "file",
          fileId: "file_1",
          name: "invoice.pdf",
          mimeType: "application/pdf",
        }),
      ).toEqual([{ type: "input_file", file_id: "file_1" }]);
    });

    /** `image/svg+xml` is an image MIME type that the API files under
     *  documents; the prefix is not the classifier, the API's list is. */
    test("an svg goes to input_file despite the image/ prefix", () => {
      expect(
        blocks({ type: "file", fileId: "file_1", name: "logo.svg", mimeType: "image/svg+xml" }),
      ).toEqual([{ type: "input_file", file_id: "file_1" }]);
    });

    /** `mimeType` is optional on `FilePart`, so a part assembled anywhere but
     *  the browser hook can arrive with only a name — and the name is what the
     *  server classifies by anyway. Also pins that the match is
     *  case-insensitive, because a camera writes `.PNG`. */
    test("with no mimeType the name decides", () => {
      expect(blocks({ type: "file", fileId: "file_1", name: "Holiday Snap.PNG" })).toEqual([
        { type: "input_image", file_id: "file_1" },
      ]);
    });

    /** A browser that cannot type a file writes `""`, not `undefined` — see
     *  `useChat.uploadFile`. It has to fall through to the name too. */
    test("an empty mimeType falls through to the name", () => {
      expect(blocks({ type: "file", fileId: "file_1", name: "scan.jpeg", mimeType: "" })).toEqual([
        { type: "input_image", file_id: "file_1" },
      ]);
    });

    test("with neither a mimeType nor a usable name it stays input_file", () => {
      expect(blocks({ type: "file", fileId: "file_1" })).toEqual([
        { type: "input_file", file_id: "file_1" },
      ]);
      expect(blocks({ type: "file", fileId: "file_2", name: "notes" })).toEqual([
        { type: "input_file", file_id: "file_2" },
      ]);
    });

    /** Precedence, pinned because nothing else in this block distinguishes the
     *  two orderings: the MIME type classifies and the name is read only when
     *  there is no MIME type. Every other case here has a name and a type that
     *  agree, so a name-first `fileContent` is green across all of them and a
     *  refactor that flipped the order would land silently. */
    test("a mimeType outranks a name that disagrees with it", () => {
      expect(
        blocks({ type: "file", fileId: "file_1", name: "report.pdf", mimeType: "image/png" }),
      ).toEqual([{ type: "input_image", file_id: "file_1" }]);
      expect(
        blocks({ type: "file", fileId: "file_2", name: "photo.png", mimeType: "application/pdf" }),
      ).toEqual([{ type: "input_file", file_id: "file_2" }]);
    });

    /** Every entry of `IMAGE_EXTENSIONS`, because the cases above happen to use
     *  two of the five and a typo in the other three would be invisible — and
     *  invisible here means an image silently sent as a document, which is a
     *  400 for the rest of that thread. The list is transcribed from the API's
     *  own rejection message, so a wrong entry is a transcription slip, exactly
     *  the kind a spot check misses. */
    test.each(["jpeg", "jpg", "png", "gif", "webp"])(
      "the name fallback recognises .%s",
      (extension) => {
        expect(blocks({ type: "file", fileId: "file_1", name: `holiday.${extension}` })).toEqual([
          { type: "input_image", file_id: "file_1" },
        ]);
      },
    );

    /** Neither block is legal on an output role, so the rule that predates the
     *  branch has to survive it: an image on an assistant message is still
     *  dropped rather than promoted to `input_image`. */
    test("a file on an assistant message is dropped whatever its type", () => {
      const items = toResponsesInput(
        [
          message({
            role: "assistant",
            content: [
              { type: "text", text: "here you go" },
              { type: "file", fileId: "file_1", name: "photo.png", mimeType: "image/png" },
            ],
          }),
        ],
        FULL,
      );
      expect(items).toEqual([
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "here you go" }],
        },
      ]);
    });
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

  test("a duplicated call is sent once — the model would otherwise read it twice", () => {
    // The shape a store that appends rather than upserts produces after a
    // threaded approval: the assistant message that made the call, then the
    // amended copy of it carrying the result, both under the same call id.
    const items = toResponsesInput(
      [
        message({
          id: "a1",
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", name: "grep", input: {} }],
        }),
        message({
          id: "a1",
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call_1", name: "grep", input: {} },
            { type: "tool-result", toolCallId: "call_1", name: "grep", status: "ok", output: "a" },
          ],
        }),
      ],
      FULL,
    );

    expect(items).toEqual([
      { type: "function_call", call_id: "call_1", name: "grep", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "a" },
    ]);
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
