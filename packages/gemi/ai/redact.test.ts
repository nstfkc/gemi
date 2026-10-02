import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../facades/Log", () => ({ Log: { error: logged.error } }));

import { HttpRequest } from "../http/HttpRequest";
import { Agent, AgentTool } from "./Agent";
import { AgentController, MemoryLiveRuns } from "./AgentController";
import { OpenAIProvider, type ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { redactError, ToolError, type ErrorRedactionInfo } from "./redact";
import { s } from "./Schema";
import { sseResponse } from "./store/sse";
import type { AgentError, AgentStreamEvent, AgentStreamFrame, ToolResultPart } from "./types";

/**
 * #446: what a client (and, for a tool's exception, the model) is told about a
 * failure. Secrets live in exception text and provider error bodies; the full
 * detail stays on `result().error`, in the log and in `onError`.
 */
const SECRET = "postgres://admin:hunter2@db.internal:5432/prod";
const AZURE_BODY = {
  error: {
    code: "DeploymentNotFound",
    message:
      "The API deployment for this resource does not exist. Resource: acme-prod-eastus, deployment: gpt-internal-7.",
  },
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  logged.error.mockReset();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

const call = (toolCallId: string, name: string): ProviderEvent => ({
  type: "tool-call",
  toolCallId,
  name,
  args: "{}",
});

function throwing(name: string, error: unknown) {
  return AgentTool.create({
    name,
    description: "Fails",
    inputSchema: s.object({}),
    execute: async () => {
      throw error;
    },
  });
}

async function events(run: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const seen: AgentStreamEvent[] = [];
  for await (const event of run) seen.push(event);
  return seen;
}

function toolResults(seen: AgentStreamEvent[]): ToolResultPart[] {
  return seen
    .filter(
      (e): e is Extract<AgentStreamEvent, { type: "tool-result" }> => e.type === "tool-result",
    )
    .map((e) => e.part as ToolResultPart);
}

function errorFrame(seen: AgentStreamEvent[]): AgentError | undefined {
  const event = seen.find((e) => e.type === "error") as { error: AgentError } | undefined;
  return event?.error;
}

describe("a tool that throws", () => {
  test("an exception's message reaches neither the model nor the client, and is logged", async () => {
    const provider = fakeProvider([call("c1", "lookup"), finish()], [finish()]);
    const agent = Agent.create({
      name: "support",
      provider,
      tools: [throwing("lookup", new Error(`connect ECONNREFUSED ${SECRET}`))],
    });
    const run = agent.stream({ messages: [], turn: { text: "hi" } });
    const response = run.toResponse();
    const result = await run.result();
    const body = await response.text();

    const part = result.messages
      .flatMap((m) => m.content)
      .find((p) => p.type === "tool-result") as ToolResultPart;
    expect(part.error).toEqual({
      code: "tool_error",
      message: 'The tool "lookup" failed with an unexpected error.',
      toolCallId: "c1",
      retryable: true,
    });
    expect(body).not.toContain("hunter2");
    // The model's next request carries the redacted result, not the secret.
    expect(JSON.stringify(provider.calls[1])).not.toContain("hunter2");
    // The server log has all of it.
    expect(logged.error).toHaveBeenCalledTimes(1);
    expect(logged.error.mock.calls[0]![0]).toContain("hunter2");
    expect(logged.error.mock.calls[0]![1]).toMatchObject({ toolCallId: "c1" });
  });

  test("a ToolError's message is meant to be read, and keeps its retryable", async () => {
    const provider = fakeProvider([call("c1", "lookup"), finish()], [finish()]);
    const agent = Agent.create({
      name: "support",
      provider,
      tools: [throwing("lookup", new ToolError("There is no order 42.", { retryable: false }))],
    });
    const seen = await events(agent.stream({ messages: [], turn: { text: "hi" } }));

    expect(toolResults(seen)[0]!.error).toEqual({
      code: "tool_error",
      message: "There is no order 42.",
      toolCallId: "c1",
      retryable: false,
    });
    expect(logged.error).not.toHaveBeenCalled();
  });

  test("logErrors: false keeps the tool's exception out of the log", async () => {
    const provider = fakeProvider([call("c1", "lookup"), finish()], [finish()]);
    const agent = Agent.create({
      name: "support",
      provider,
      logErrors: false,
      tools: [throwing("lookup", new Error("boom"))],
    });
    await agent.stream({ messages: [], turn: { text: "hi" } }).result();
    expect(logged.error).not.toHaveBeenCalled();
  });

  test("a sub-agent's tool is redacted by the redactor its parent was given", async () => {
    const inner = Agent.create({
      name: "inner",
      provider: fakeProvider([call("i1", "db"), finish()], [finish()]),
      tools: [throwing("db", new Error(SECRET))],
    });
    const outer = AgentTool.create({
      name: "delegate",
      description: "Delegates",
      inputSchema: s.object({}),
      execute: async (_input, ctx) => {
        await ctx.runAgent(inner, { prompt: "go" });
        return "done";
      },
    });
    const agent = Agent.create({
      name: "outer",
      provider: fakeProvider([call("c1", "delegate"), finish()], [finish()]),
      tools: [outer],
    });
    const redactor = vi.fn((error: AgentError) => ({
      ...error,
      message: "custom",
    }));
    const run = agent.stream({
      messages: [],
      turn: { text: "hi" },
      redactError: redactor,
    });
    const response = run.toResponse();
    await run.result();
    const body = await response.text();

    expect(body).not.toContain("hunter2");
    expect(body).toContain('"message":"custom"');
    expect(redactor).toHaveBeenCalledWith(
      expect.objectContaining({ code: "tool_error" }),
      expect.objectContaining({ source: "tool", toolName: "db" }),
    );
  });
});

describe("a provider failure", () => {
  test("the error frame says what kind of failure it was, not what the provider said", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(AZURE_BODY), {
          status: 404,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_secret",
          },
        }),
    ) as unknown as typeof fetch;
    const agent = Agent.create({
      name: "director",
      provider: OpenAIProvider.model("gpt-5.4", { apiKey: "k", maxRetries: 0 }),
    });
    const run = agent.stream({ messages: [], turn: { text: "hi" } });
    const response = run.toResponse();
    const result = await run.result();
    const body = await response.text();

    expect(body).not.toContain("acme-prod-eastus");
    expect(body).not.toContain("req_secret");
    expect(body).toContain('"message":"The model provider returned an error."');
    // The server's copy is whole.
    expect(result.error).toMatchObject({
      status: 404,
      requestId: "req_secret",
    });
    expect(result.error!.message).toContain("acme-prod-eastus");
  });

  test("an unreachable endpoint does not name its host to the client", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND acme-prod.openai.azure.com");
    }) as unknown as typeof fetch;
    const agent = Agent.create({
      name: "director",
      provider: OpenAIProvider.model("gpt-5.4", { apiKey: "k", maxRetries: 0 }),
    });
    const seen = await events(agent.stream({ messages: [], turn: { text: "hi" } }));
    expect(errorFrame(seen)).toEqual({
      code: "provider_error",
      message: "The model provider returned an error.",
      retryable: true,
    });
  });

  test.each([
    ["rate_limited", "The model provider is rate limiting requests. Try again shortly."],
    ["context_length_exceeded", "The conversation is too long for the model."],
    ["content_filtered", "The model provider's content filter blocked this request."],
  ] as const)("%s keeps its code and gets a fixed sentence", async (code, message) => {
    const provider = fakeProvider([
      {
        type: "error",
        error: { code, message: `raw ${SECRET}`, retryable: false },
      },
    ]);
    const agent = Agent.create({ name: "a", provider });
    const seen = await events(agent.stream({ messages: [], turn: { text: "hi" } }));
    expect(errorFrame(seen)).toEqual({ code, message, retryable: false });
  });

  test("a failure gemi wrote keeps its message", async () => {
    const provider = fakeProvider([
      {
        type: "error",
        error: { code: "timeout", message: "took too long", retryable: true },
      },
    ]);
    const agent = Agent.create({ name: "a", provider });
    const seen = await events(agent.stream({ messages: [], turn: { text: "hi" } }));
    expect(errorFrame(seen)?.message).toBe("took too long");
  });
});

describe("a custom redactor", () => {
  const failing = () =>
    fakeProvider([
      {
        type: "error",
        error: { code: "provider_error", message: SECRET, retryable: false },
      },
    ]);

  test("only the AgentError fields of what it returns are sent", async () => {
    const agent = Agent.create({ name: "a", provider: failing() });
    const seen = await events(
      agent.stream({
        messages: [],
        turn: { text: "hi" },
        // Spreading the failure is the mistake this guards against.
        redactError: (error, info) => ({
          ...(info.source === "run" ? info.failure : error),
          message: "shown",
          secret: SECRET,
        }),
      }),
    );
    expect(errorFrame(seen)).toStrictEqual({
      code: "provider_error",
      message: "shown",
      retryable: false,
    });
  });

  test("one that throws falls back to the default, not to the raw error", async () => {
    const agent = Agent.create({ name: "a", provider: failing() });
    const seen = await events(
      agent.stream({
        messages: [],
        turn: { text: "hi" },
        redactError: () => {
          throw new Error("oops");
        },
      }),
    );
    expect(errorFrame(seen)?.message).toBe("The model provider returned an error.");
  });
});

describe("AgentController", () => {
  function request() {
    const raw = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [], text: "hi" }),
    });
    return new HttpRequest(raw, {}, "api", "/chat");
  }

  test("redactError decides the frame, and onError still gets the full error", async () => {
    const provider = fakeProvider([
      {
        type: "error",
        error: { code: "provider_error", message: SECRET, retryable: false },
      },
    ]);
    const seenByHook: AgentError[] = [];
    const infos: ErrorRedactionInfo[] = [];
    const runIds: string[] = [];

    class Chat extends AgentController {
      agent = Agent.create({ name: "a", provider });
      liveRuns = new MemoryLiveRuns();
      protected redactError(error: AgentError, info: ErrorRedactionInfo, ctx: any) {
        infos.push(info);
        runIds.push(ctx.runId);
        return { ...redactError(error, info), message: "Sorry, try again." };
      }
      protected onError(error: AgentError) {
        seenByHook.push(error);
      }
    }

    const response = await new Chat().stream(request());
    const body = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(body).toContain('"message":"Sorry, try again."');
    expect(body).not.toContain("hunter2");
    expect(seenByHook[0]!.message).toBe(SECRET);
    expect(infos[0]).toMatchObject({
      source: "run",
      failure: { message: SECRET },
    });
    // The hook context names the run the client was told about.
    expect(body).toContain(`"runId":"${runIds[0]}"`);
  });
});

describe("the SSE transport", () => {
  async function failingWith(err: unknown): Promise<string> {
    const frames: AsyncIterable<AgentStreamFrame> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    return await sseResponse(frames).text();
  }

  test("a store's exception is not sent", async () => {
    const body = await failingWith(new Error(`Redis at ${SECRET} refused`));
    expect(body).not.toContain("hunter2");
    expect(body).toContain("The run's stream failed.");
  });

  test("a cursor the buffer no longer holds is still named", async () => {
    const body = await failingWith(
      Object.assign(new Error("Frames before 12 of run_1 are gone."), {
        code: "frame_cursor_evicted",
      }),
    );
    expect(body).toContain("Frames before 12 of run_1 are gone.");
  });
});

describe("redactError", () => {
  test("is a pure function an override can fall back to", () => {
    const error: AgentError = {
      code: "unknown",
      message: SECRET,
      retryable: false,
    };
    expect(redactError(error, { source: "run", failure: error })).toEqual({
      code: "unknown",
      message: "The run failed unexpectedly.",
      retryable: false,
    });
  });
});
