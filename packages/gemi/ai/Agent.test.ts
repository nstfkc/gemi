process.env.SECRET ??= "agent-test-secret";

import { describe, expect, test, vi } from "vitest";
import { Agent, AgentTool, Skill, ToolNamespace } from "./Agent";
import type { AgentProvider, ProviderEvent, ProviderStreamParams } from "./AgentProvider";
import type { Schema } from "./Schema";
import type {
  AgentMessage,
  AgentStreamEvent,
  ClientToolResult,
  PendingToolCall,
  Usage,
} from "./types";

/**
 * A schema built by hand rather than with `s`.
 *
 * `Schema<T>` carries a phantom property keyed by a symbol `Schema.ts` does not
 * export, so nothing outside that file can produce one without a cast — and the
 * agent loop only ever calls `safeParse` and `toJSONSchema`, so a fake keeps
 * these tests independent of the builder's own progress.
 */
function schemaOf<T>(validate: (value: any) => string[], json: any = { type: "object" }): Schema<T> {
  const schema = {
    toJSONSchema: () => json,
    parse(value: unknown) {
      const result = schema.safeParse(value);
      if (result.ok === false) throw new Error(result.errors.join(", "));
      return result.value;
    },
    safeParse(value: unknown) {
      const errors = validate(value);
      return errors.length > 0
        ? { ok: false as const, errors }
        : { ok: true as const, value: value as T };
    },
  };
  return schema as unknown as Schema<T>;
}

const stringField = (field: string) =>
  schemaOf<any>((value) =>
    value && typeof value[field] === "string" ? [] : [`${field}: expected a string`],
  );

const anything = () => schemaOf<any>(() => []);

const usage = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});

/**
 * Scripted `ProviderEvent`s, one script per model call.
 *
 * The real provider is written against the same interface elsewhere; depending
 * on it here would make these tests a test of two things at once, and would
 * need a network.
 */
class FakeProvider {
  readonly model = "fake";
  readonly capabilities = {
    reasoning: true,
    structuredOutput: true,
    fileInput: true,
    parallelToolCalls: true,
    toolSearch: true,
  };
  readonly calls: ProviderStreamParams[] = [];

  constructor(private scripts: ProviderEvent[][]) {}

  stream(params: ProviderStreamParams) {
    this.calls.push(params);
    const script = this.scripts[this.calls.length - 1] ?? [
      { type: "finish", reason: "stop", usage: usage(0, 0) },
    ];
    return (async function* () {
      for (const event of script) yield event;
    })();
  }

  async upload() {
    return "file_1";
  }

  normalizeError(error: unknown) {
    return {
      code: "provider_error" as const,
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

function fakeProvider(...scripts: ProviderEvent[][]) {
  return new FakeProvider(scripts) as unknown as AgentProvider & FakeProvider;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains a run into an array while it keeps going. */
function collect(run: { [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> }) {
  const events: AgentStreamEvent[] = [];
  const done = (async () => {
    for await (const event of run as AsyncIterable<AgentStreamEvent>) events.push(event);
  })();
  return { events, done };
}

const textOf = (message: AgentMessage) =>
  message.content
    .filter((part) => part.type === "text")
    .map((part: any) => part.text)
    .join("");

const partsOf = (messages: AgentMessage[], type: string) =>
  messages.flatMap((message) => message.content.filter((part) => part.type === type)) as any[];

const req = {} as any;

// --- fixtures ------------------------------------------------------------

function greetAgent(provider: AgentProvider) {
  return Agent.create({ name: "greeter", instructions: "Be brief.", provider });
}

const grepCalls: string[] = [];
const grep = AgentTool.create({
  name: "grep",
  description: "Search",
  inputSchema: stringField("pattern"),
  outputSchema: anything(),
  execute: async (input: any) => {
    grepCalls.push(input.pattern);
    return { matches: [`hit:${input.pattern}`] };
  },
});

const refundCalls: string[] = [];
const refundOrder = AgentTool.create({
  name: "refundOrder",
  description: "Refund an order",
  inputSchema: stringField("orderId"),
  outputSchema: anything(),
  requiresApproval: true,
  execute: async (input: any) => {
    refundCalls.push(input.orderId);
    return { refundId: `rf_${input.orderId}` };
  },
});

const askUser = AgentTool.ask({
  name: "ask",
  description: "Ask the customer something",
  outputSchema: schemaOf<{ answer: string }>((value) =>
    value && typeof value.answer === "string" ? [] : ["answer: expected a string"],
  ),
});

const toolCall = (toolCallId: string, name: string, args: unknown): ProviderEvent => ({
  type: "tool-call",
  toolCallId,
  name,
  args: JSON.stringify(args),
});

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: usage(10, 5),
});

// --- tests ---------------------------------------------------------------

describe("a plain run", () => {
  test("streams text, ends `stop`, and reports what it produced", async () => {
    const provider = fakeProvider([
      { type: "text-delta", delta: "Hel" },
      { type: "text-delta", delta: "lo" },
      finish(),
    ]);
    const run = greetAgent(provider).stream({ messages: [], req, turn: { text: "hi" } });
    const { events, done } = collect(run);
    const result = await run.result();
    await done;

    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual(usage(10, 5));
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(textOf(result.messages[1])).toBe("Hello");
    expect(events.filter((event) => event.type === "text-delta").length).toBe(2);
    expect(events[0]).toMatchObject({ type: "run-start" });
    expect(events[events.length - 1]).toMatchObject({ type: "run-end", finishReason: "stop" });
  });

  test("puts the agent's instructions and the request's in the system prompt", async () => {
    const provider = fakeProvider([finish()]);
    const run = greetAgent(provider).stream({
      messages: [],
      req,
      instructions: "Today is Tuesday.",
    });
    await run.result();
    expect(provider.calls[0].systemPrompt).toBe("Be brief.\n\nToday is Tuesday.");
  });
});

describe("a tool call", () => {
  test("runs, and its result goes back to the model on the next step", async () => {
    grepCalls.length = 0;
    const provider = fakeProvider(
      [toolCall("c1", "grep", { pattern: "needle" }), finish()],
      [{ type: "text-delta", delta: "found it" }, finish()],
    );
    const agent = Agent.create({ name: "coder", provider, tools: [grep] });
    const run = agent.stream({ messages: [], req, turn: { text: "search" } });
    const { events, done } = collect(run);
    const result = await run.result();
    await done;

    expect(grepCalls).toEqual(["needle"]);
    expect(provider.calls.length).toBe(2);
    expect(result.finishReason).toBe("stop");
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
      status: "ok",
      output: { matches: ["hit:needle"] },
    });
    // Usage adds up across steps rather than reporting only the last call.
    expect(result.usage).toEqual(usage(20, 10));
    expect(events.some((event) => event.type === "tool-result")).toBe(true);
  });

  test("an unparseable argument comes back as a result the model can fix", async () => {
    const provider = fakeProvider(
      [toolCall("c1", "grep", { wrong: 1 }), finish()],
      [{ type: "text-delta", delta: "sorry, retrying" }, finish()],
    );
    const agent = Agent.create({ name: "coder", provider, tools: [grep] });
    const result = await agent.stream({ messages: [], req }).result();

    const errors = partsOf(result.messages, "tool-result");
    expect(errors[0].status).toBe("error");
    expect(errors[0].error.code).toBe("invalid_tool_input");
    // The point of not throwing: the run kept going and the model answered.
    expect(provider.calls.length).toBe(2);
    expect(result.finishReason).toBe("stop");
  });

  test("a throwing tool is a result, not an exception out of the run", async () => {
    const boom = AgentTool.create({
      name: "boom",
      description: "Always fails",
      inputSchema: anything(),
      execute: async () => {
        throw new Error("disk on fire");
      },
    });
    const provider = fakeProvider([toolCall("c1", "boom", {}), finish()], [finish()]);
    const agent = Agent.create({ name: "coder", provider, tools: [boom] });
    const result = await agent.stream({ messages: [], req }).result();

    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
      status: "error",
      error: { code: "tool_error", message: "disk on fire" },
    });
    expect(result.finishReason).toBe("stop");
  });

  test("a generator tool yields progress and returns a result", async () => {
    const streaming = AgentTool.create({
      name: "bash",
      description: "Run a command",
      inputSchema: anything(),
      execute: async function* () {
        yield { line: "$ ls" };
        yield { line: "a.txt" };
        return { exitCode: 0 };
      },
    });
    const provider = fakeProvider([toolCall("c1", "bash", {}), finish()], [finish()]);
    const agent = Agent.create({ name: "coder", provider, tools: [streaming] });
    const run = agent.stream({ messages: [], req });
    const { events, done } = collect(run);
    const result = await run.result();
    await done;

    expect(
      events.filter((event) => event.type === "tool-progress").map((event: any) => event.data),
    ).toEqual([{ line: "$ ls" }, { line: "a.txt" }]);
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
      status: "ok",
      output: { exitCode: 0 },
    });
  });

  test("stops at maxSteps rather than throwing", async () => {
    const script = () => [toolCall(`c${Math.random()}`, "grep", { pattern: "x" }), finish()];
    const provider = fakeProvider(script(), script(), script());
    const agent = Agent.create({ name: "looper", provider, tools: [grep], maxSteps: 2 });
    const result = await agent.stream({ messages: [], req }).result();

    expect(result.finishReason).toBe("max-steps");
    expect(provider.calls.length).toBe(2);
    expect(result.messages[result.messages.length - 1].finishReason).toBe("max-steps");
  });
});

// --- approvals -----------------------------------------------------------

function approvalAgent(...scripts: ProviderEvent[][]) {
  const provider = fakeProvider(...scripts);
  return {
    provider,
    agent: Agent.create({ name: "support", provider, tools: [refundOrder, askUser] }),
  };
}

/** Runs the first turn of the approval conversation. */
async function askForApproval() {
  refundCalls.length = 0;
  const { agent, provider } = approvalAgent([
    toolCall("c1", "refundOrder", { orderId: "ord_1" }),
    finish(),
  ]);
  const run = agent.stream({ messages: [], req, turn: { text: "refund it" } });
  const { events, done } = collect(run);
  const result = await run.result();
  await done;
  const awaiting = events.find((event) => event.type === "awaiting-input") as any;
  return { agent, provider, result, events, pending: awaiting?.pending as PendingToolCall[] };
}

describe("an approval", () => {
  test("ends the run awaiting-input without running the tool", async () => {
    const { result, pending, events } = await askForApproval();

    expect(refundCalls).toEqual([]);
    expect(result.finishReason).toBe("awaiting-input");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolCallId: "c1", name: "refundOrder", kind: "approval" });
    expect(pending[0].signature).toBeTruthy();
    // Terminal: the run is finished, not parked.
    expect(events[events.length - 1]).toMatchObject({
      type: "run-end",
      finishReason: "awaiting-input",
    });
  });

  test("carries through to completion on the next turn", async () => {
    const first = await askForApproval();
    const answer: ClientToolResult = {
      toolCallId: "c1",
      signature: first.pending[0].signature,
      approve: true,
    };

    const provider = fakeProvider([{ type: "text-delta", delta: "refunded" }, finish()]);
    const agent = Agent.create({ name: "support", provider, tools: [refundOrder, askUser] });
    const result = await agent
      .stream({ messages: first.result.messages, req, turn: { toolResults: [answer] } })
      .result();

    expect(refundCalls).toEqual(["ord_1"]);
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
      toolCallId: "c1",
      status: "ok",
      output: { refundId: "rf_ord_1" },
    });
    expect(textOf(result.messages[result.messages.length - 1])).toBe("refunded");
    // The history the provider was handed has no dangling call in it.
    const sent = provider.calls[0].messages.flatMap((message) => message.content);
    expect(sent.filter((part) => part.type === "tool-call")).toHaveLength(1);
    expect(sent.filter((part) => part.type === "tool-result")).toHaveLength(1);
  });

  test("a refusal leaves a denied result the model can read", async () => {
    const first = await askForApproval();
    const provider = fakeProvider([{ type: "text-delta", delta: "understood" }, finish()]);
    const agent = Agent.create({ name: "support", provider, tools: [refundOrder, askUser] });
    const result = await agent
      .stream({
        messages: first.result.messages,
        req,
        turn: {
          toolResults: [
            { toolCallId: "c1", signature: first.pending[0].signature, approve: false, reason: "too late" },
          ],
        },
      })
      .result();

    expect(refundCalls).toEqual([]);
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
      status: "denied",
      cause: "refused",
      reason: "too late",
    });
  });

  test("a turn that answers nothing denies what was left open", async () => {
    const first = await askForApproval();
    const provider = fakeProvider([{ type: "text-delta", delta: "ok" }, finish()]);
    const agent = Agent.create({ name: "support", provider, tools: [refundOrder, askUser] });
    const result = await agent
      .stream({ messages: first.result.messages, req, turn: { text: "actually, what is my balance?" } })
      .result();

    expect(refundCalls).toEqual([]);
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
      status: "denied",
      cause: "refused",
    });
    expect(provider.calls[0].messages.at(-1).content[0]).toMatchObject({ type: "text" });
  });

  test("rejects an approval whose input was rewritten on the way back", async () => {
    const first = await askForApproval();
    // A hostile client: the signature is genuine, the input is not.
    const call: any = first.result.messages
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool-call");
    call.input = { orderId: "ord_99" };

    const provider = fakeProvider([{ type: "text-delta", delta: "hm" }, finish()]);
    const agent = Agent.create({ name: "support", provider, tools: [refundOrder, askUser] });
    const run = agent.stream({
      messages: first.result.messages,
      req,
      turn: {
        toolResults: [{ toolCallId: "c1", signature: first.pending[0].signature, approve: true }],
      },
    });
    const { events, done } = collect(run);
    const result = await run.result();
    await done;

    expect(refundCalls).toEqual([]);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      error: { code: "invalid_tool_result" },
    });
    // Rejected, but not left dangling: it falls through to the implicit denial.
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
      status: "denied",
      cause: "refused",
    });
  });

  test("rejects a client that supplies an approval tool's output instead of approving", async () => {
    const first = await askForApproval();
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({ name: "support", provider, tools: [refundOrder, askUser] });
    const run = agent.stream({
      messages: first.result.messages,
      req,
      turn: {
        toolResults: [
          {
            toolCallId: "c1",
            signature: first.pending[0].signature,
            output: { refundId: "rf_forged" },
          },
        ],
      },
    });
    const { events, done } = collect(run);
    const result = await run.result();
    await done;

    expect(events.find((event) => event.type === "error")).toMatchObject({
      error: { code: "invalid_tool_result" },
    });
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({ status: "denied" });
  });

  test("rejects a result for a call the server never made", async () => {
    const first = await askForApproval();
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({ name: "support", provider, tools: [refundOrder, askUser] });
    const run = agent.stream({
      messages: first.result.messages,
      req,
      turn: {
        toolResults: [
          { toolCallId: "c1", signature: first.pending[0].signature, approve: false },
          { toolCallId: "ghost", signature: first.pending[0].signature, approve: true },
        ],
      },
    });
    const { events, done } = collect(run);
    await run.result();
    await done;

    expect(
      events.filter((event) => event.type === "error").map((event: any) => event.error.toolCallId),
    ).toEqual(["ghost"]);
  });
});

describe("a client-answered tool", () => {
  test("ends awaiting-input and validates the answer against its output schema", async () => {
    const { agent } = approvalAgent([toolCall("c1", "ask", { question: "which invoice?" }), finish()]);
    const run = agent.stream({ messages: [], req, turn: { text: "refund something" } });
    const { events, done } = collect(run);
    const first = await run.result();
    await done;
    const pending = (events.find((event) => event.type === "awaiting-input") as any)
      .pending as PendingToolCall[];
    expect(pending[0].kind).toBe("question");

    const provider = fakeProvider([finish()], [finish()]);
    const agent2 = Agent.create({ name: "support", provider, tools: [refundOrder, askUser] });

    const bad = await agent2
      .stream({
        messages: first.messages,
        req,
        turn: { toolResults: [{ toolCallId: "c1", signature: pending[0].signature, output: { answer: 42 } }] },
      })
      .result();
    expect(partsOf(bad.messages, "tool-result")[0]).toMatchObject({
      status: "error",
      error: { code: "invalid_tool_result" },
    });

    const good = await agent2
      .stream({
        messages: first.messages,
        req,
        turn: {
          toolResults: [
            { toolCallId: "c1", signature: pending[0].signature, output: { answer: "the March one" } },
          ],
        },
      })
      .result();
    expect(partsOf(good.messages, "tool-result")[0]).toMatchObject({
      status: "ok",
      output: { answer: "the March one" },
    });
  });
});

// --- stopping ------------------------------------------------------------

describe("stop()", () => {
  test("leaves a valid transcript: a stopped result and an aborted message", async () => {
    const started = deferred();
    const hang = AgentTool.create({
      name: "hang",
      description: "Never returns",
      inputSchema: anything(),
      // Deliberately ignores the signal. A tool that does not cooperate must
      // not be able to hold the run open.
      execute: () => {
        started.resolve();
        return new Promise<any>(() => {});
      },
    });
    const provider = fakeProvider([
      { type: "text-delta", delta: "working on it" },
      toolCall("c1", "hang", {}),
      finish(),
    ]);
    const agent = Agent.create({ name: "slow", provider, tools: [hang] });
    const messages: AgentMessage[] = [];
    const run = agent.stream({
      messages: [],
      req,
      onMessage: (message) => {
        messages.push(message);
      },
    });
    const { events, done } = collect(run);

    await started.promise;
    run.stop({ reason: "user pressed stop" });
    const result = await run.result();
    await done;

    expect(result.finishReason).toBe("aborted");
    const message = result.messages[result.messages.length - 1];
    expect(message.finishReason).toBe("aborted");
    // The text it had already produced survives; losing it would lose words the
    // user has already read.
    expect(textOf(message)).toBe("working on it");
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
      status: "denied",
      cause: "stopped",
      reason: "user pressed stop",
    });
    expect(events.some((event) => event.type === "tool-result")).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ finishReason: "aborted" });
    // And it went through the message callback, so it is persisted whether or
    // not anyone was watching.
    expect(messages.map((m) => m.finishReason)).toContain("aborted");
  });

  test("an external signal stops the run the same way", async () => {
    const started = deferred();
    const hang = AgentTool.create({
      name: "hang2",
      description: "Never returns",
      inputSchema: anything(),
      execute: () => {
        started.resolve();
        return new Promise<any>(() => {});
      },
    });
    const controller = new AbortController();
    const provider = fakeProvider([toolCall("c1", "hang2", {}), finish()]);
    const agent = Agent.create({ name: "slow", provider, tools: [hang] });
    const run = agent.stream({ messages: [], req, signal: controller.signal });
    await started.promise;
    controller.abort();
    expect((await run.result()).finishReason).toBe("aborted");
  });
});

describe("a run outliving its request", () => {
  test("a reader going away is not a stop", async () => {
    const release = deferred<any>();
    const slow = AgentTool.create({
      name: "slow",
      description: "Finishes eventually",
      inputSchema: anything(),
      execute: () => release.promise,
    });
    const provider = fakeProvider([toolCall("c1", "slow", {}), finish()], [finish()]);
    const agent = Agent.create({ name: "patient", provider, tools: [slow] });
    const run = agent.stream({ messages: [], req });

    const response = run.toResponse();
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    await response.body!.cancel();

    release.resolve({ ok: true });
    const result = await run.result();
    expect(result.finishReason).toBe("stop");
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({ status: "ok" });
  });

  test("frames replay from a cursor, which is what makes reattaching possible", async () => {
    const provider = fakeProvider([
      { type: "text-delta", delta: "a" },
      { type: "text-delta", delta: "b" },
      { type: "text-delta", delta: "c" },
      finish(),
    ]);
    const run = greetAgent(provider).stream({ messages: [], req });
    await run.result();

    const all: number[] = [];
    for await (const frame of run.frames()) all.push(frame.seq);
    expect(all[0]).toBe(1);
    expect(all).toEqual(all.map((_, index) => index + 1));

    const tail: number[] = [];
    for await (const frame of run.frames(4)) tail.push(frame.seq);
    expect(tail).toEqual(all.slice(3));
  });

  test("toResponse writes the cursor into the SSE id field", async () => {
    const provider = fakeProvider([{ type: "text-delta", delta: "hi" }, finish()]);
    const run = greetAgent(provider).stream({ messages: [], req });
    await run.result();

    const body = await run.toResponse({ from: 2 }).text();
    expect(body.startsWith("id: 2\ndata: {")).toBe(true);
    expect(body).toContain('"type":"text-delta"');
    expect(body.endsWith("\n\n")).toBe(true);
  });
});

// --- skills and lowering -------------------------------------------------

describe("skills", () => {
  test("lower into the reserved namespace, and their body is read on load", async () => {
    const instructions = vi.fn(() => "Refund within 30 days.");
    const skill = Skill.create({
      name: "refund-policy",
      description: "How refunds are decided",
      instructions,
    });
    const provider = fakeProvider(
      [toolCall("c1", "refund-policy", {}), finish()],
      [{ type: "text-delta", delta: "within 30 days" }, finish()],
    );
    const agent = Agent.create({ name: "support", provider, tools: [grep], skills: [skill] });

    // Nothing was read at startup: an agent with twelve skills should not read
    // twelve files to answer "hello".
    expect(instructions).not.toHaveBeenCalled();

    const result = await agent.stream({ messages: [], req }).result();
    expect(instructions).toHaveBeenCalledTimes(1);

    const namespaces = provider.calls[0].tools as any[];
    const skills = namespaces.find((entry) => entry.name === "skills");
    expect(skills.tools).toHaveLength(1);
    expect(skills.tools[0]).toMatchObject({
      name: "refund-policy",
      description: "How refunds are decided",
      parameters: { type: "object", properties: {}, required: [] },
    });
    expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
      status: "ok",
      output: "Refund within 30 days.",
    });
  });

  test("an app namespace cannot be called `skills`", () => {
    const shadow = ToolNamespace.create({
      name: "skills",
      description: "…",
      tools: [grep],
    });
    expect(() =>
      Agent.create({ name: "x", provider: fakeProvider(), tools: [shadow] }),
    ).toThrow(/reserved/);
  });

  test("two tools may not share a name, because the client discriminates on it", () => {
    const twin = AgentTool.create({
      name: "grep",
      description: "Another search",
      inputSchema: anything(),
      execute: async () => ({}),
    });
    expect(() =>
      Agent.create({ name: "x", provider: fakeProvider(), tools: [grep, twin] }),
    ).toThrow(/Two tools are named/);
  });
});

describe("namespaces", () => {
  test("flatten for dispatch and stay grouped for the model, carrying deferred through", async () => {
    const crm = ToolNamespace.create({
      name: "crm",
      description: "Customer records",
      deferred: true,
      tools: [refundOrder],
    });
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({ name: "support", provider, tools: [grep, crm] });
    await agent.stream({ messages: [], req }).result();

    const tools = provider.calls[0].tools as any[];
    expect(tools[0]).toMatchObject({ name: "grep", deferred: false });
    expect(tools[1]).toMatchObject({
      name: "crm",
      description: "Customer records",
      tools: [{ name: "refundOrder", deferred: true }],
    });
    expect(refundOrder.namespace).toBe("crm");
  });
});
