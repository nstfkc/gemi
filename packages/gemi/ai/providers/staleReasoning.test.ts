process.env.SECRET ??= "stale-reasoning-test-secret";

import { describe, expect, test } from "vitest";

import { Agent } from "../Agent";
import { AzureOpenAIProvider, type ProviderEvent } from "../AgentProvider";
import type { AgentMessage, FinishReason } from "../types";
import { responsesEndpoint, streamResponses, type ResponsesEndpoint } from "./call";
import { ProviderHttpError } from "./errors";
import type { FetchLike } from "./http";
import { buildResponsesRequest, toResponsesInput, type ResponsesRequest } from "./request";
import { withoutStaleReasoning } from "./staleReasoning";

/**
 * A reasoning item replayed by an id the API never stored.
 *
 * Seen in fager on Azure (gpt-6.1-sol): a main step was cut by
 * `streamMaxDurationMs` after its reasoning had started streaming, the run
 * failed, and the message it wrote kept the reasoning part with its `rs_…` id.
 * The next turn replayed that id and was refused with
 * `400 Item with id 'rs_…' not found.`, and so was every turn after it.
 */

const CAPS = {
  reasoning: true,
  structuredOutput: true,
  fileInput: true,
  parallelToolCalls: true,
  toolSearch: true,
};

/** The body Azure answered with; the message is verbatim from the log. */
const notFound = (id: string) => ({
  error: {
    message: `Item with id '${id}' not found.`,
    type: "invalid_request_error",
    param: "input",
    code: null,
  },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const frame = (payload: Record<string, unknown>) =>
  `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;

/** A 200 whose body sends `frames`, then either ends or breaks the socket. */
function sse(frames: string[], end: "close" | "drop" = "close"): Response {
  const encoder = new TextEncoder();
  const queue = [...frames];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(encoder.encode(next));
      else if (end === "drop") {
        controller.error(new TypeError("The socket connection was closed unexpectedly."));
      } else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const reasoningFrames = (id: string) => [
  frame({ type: "response.created", response: { model: "gpt-x" } }),
  frame({ type: "response.output_item.added", item: { type: "reasoning", id } }),
  frame({ type: "response.reasoning_summary_text.delta", item_id: id, delta: "Thinking." }),
];

const answerFrames = (text: string) => [
  frame({ type: "response.created", response: { model: "gpt-x" } }),
  frame({ type: "response.output_text.delta", delta: text }),
  frame({
    type: "response.completed",
    response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  }),
];

function assistant(
  id: string,
  finishReason: FinishReason | undefined,
  ...content: AgentMessage["content"]
): AgentMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-11-11",
    ...(finishReason ? { finishReason } : {}),
  };
}

const user = (id: string, text: string): AgentMessage => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  createdAt: "2026-11-11",
});

const reasoningIds = (input: Record<string, unknown>[]) =>
  input.filter((item) => item.type === "reasoning").map((item) => item.id);

describe("toResponsesInput(), reasoning of an unfinished response", () => {
  test.each(["error", "aborted", "interrupted"] as const)(
    "a message that finished %s does not replay its reasoning, and keeps its text",
    (reason) => {
      const input = toResponsesInput(
        [
          user("u1", "hi"),
          assistant(
            "a1",
            reason,
            { type: "reasoning", id: "rs_dead", text: "Thinking." },
            { type: "text", text: "Half an ans" },
          ),
        ],
        CAPS,
      );
      expect(reasoningIds(input)).toEqual([]);
      expect(JSON.stringify(input)).toContain("Half an ans");
    },
  );

  test.each(["stop", "length", "awaiting-input", "max-steps", undefined] as const)(
    "a message that finished %s replays its reasoning as before",
    (reason) => {
      const input = toResponsesInput(
        [
          user("u1", "hi"),
          assistant("a1", reason, { type: "reasoning", id: "rs_ok", text: "Thinking." }, {
            type: "text",
            text: "Done.",
          }),
        ],
        CAPS,
      );
      expect(reasoningIds(input)).toEqual(["rs_ok"]);
    },
  );
});

describe("withoutStaleReasoning()", () => {
  const body = buildResponsesRequest(
    {
      messages: [
        user("u1", "hi"),
        assistant("a1", "stop", { type: "reasoning", id: "rs_a" }, { type: "text", text: "a" }),
        user("u2", "again"),
        assistant("a2", "stop", { type: "reasoning", id: "rs_b" }, { type: "text", text: "b" }),
        user("u3", "and again"),
      ],
    },
    { model: "gpt-x", capabilities: CAPS },
  );

  test("takes out every reasoning item when the refusal names one this request sent", () => {
    const stripped = withoutStaleReasoning(body, new ProviderHttpError(400, notFound("rs_a")));
    expect(stripped).not.toBeNull();
    expect(reasoningIds(stripped!.input)).toEqual([]);
    expect(stripped!.input).toHaveLength(body.input.length - 2);
    // The caller's body is what was sent; the retry is a copy.
    expect(reasoningIds(body.input)).toEqual(["rs_a", "rs_b"]);
  });

  test("leaves anything else alone", () => {
    // An id this request did not send.
    expect(withoutStaleReasoning(body, new ProviderHttpError(400, notFound("rs_other")))).toBeNull();
    // A missing item that is not reasoning.
    expect(withoutStaleReasoning(body, new ProviderHttpError(400, notFound("fc_1")))).toBeNull();
    // Not a refusal.
    expect(withoutStaleReasoning(body, new ProviderHttpError(500, notFound("rs_a")))).toBeNull();
    expect(withoutStaleReasoning(body, new Error("Item with id 'rs_a' not found."))).toBeNull();
    // Not a Responses body (the Anthropic provider shares `streamResponses`).
    expect(
      withoutStaleReasoning({ messages: [] }, new ProviderHttpError(400, notFound("rs_a"))),
    ).toBeNull();
  });
});

/** `streamResponses` with a scripted `fetch`, recording every body sent. */
function harness(responses: Response[]) {
  const bodies: ResponsesRequest[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return responses[Math.min(i++, responses.length - 1)]!.clone();
  };
  const endpoint: ResponsesEndpoint = {
    ...responsesEndpoint({
      base: "https://azure.example/openai/v1",
      query: "?api-version=preview",
      headers: async () => ({ "api-key": "k" }),
      timeoutMs: 0,
      maxRetries: 0,
    } as never),
    fetchImpl,
  };
  return {
    bodies,
    async run(messages: AgentMessage[]) {
      const body = buildResponsesRequest({ messages }, { model: "gpt-x", capabilities: CAPS });
      const events: ProviderEvent[] = [];
      for await (const event of streamResponses(endpoint, body, { structuredOutput: false })) {
        events.push(event);
      }
      return events;
    },
  };
}

const STORED: AgentMessage[] = [
  user("u1", "hi"),
  assistant("a1", "stop", { type: "reasoning", id: "rs_gone" }, { type: "text", text: "Hello." }),
  user("u2", "again"),
];

describe("streamResponses() and a reasoning item the API does not have", () => {
  test("is asked again once, without the reasoning, and answers", async () => {
    const h = harness([json(400, notFound("rs_gone")), sse(answerFrames("ok"))]);
    const events = await h.run(STORED);

    expect(h.bodies).toHaveLength(2);
    expect(reasoningIds(h.bodies[0]!.input)).toEqual(["rs_gone"]);
    expect(reasoningIds(h.bodies[1]!.input)).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["text-delta", "finish"]);
  });

  test("only once: a second refusal fails the call", async () => {
    const h = harness([json(400, notFound("rs_gone")), json(400, notFound("rs_gone"))]);
    const events = await h.run(STORED);
    expect(h.bodies).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(["error", "finish"]);
  });

  test("a refusal naming an id this request did not send is not retried", async () => {
    const h = harness([json(400, notFound("rs_elsewhere"))]);
    const events = await h.run(STORED);
    expect(h.bodies).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["error", "finish"]);
  });
});

/**
 * A fake Azure Responses endpoint behind a real `AzureOpenAIProvider`: answers
 * from `script` in order, except that a request replaying a reasoning id it
 * never completed is refused the way Azure refuses it, before the script is
 * consulted.
 */
function azure(script: Array<Response | (() => Response)>) {
  const bodies: ResponsesRequest[] = [];
  const unstored = new Set<string>();
  let i = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as ResponsesRequest;
    bodies.push(body);
    const stale = reasoningIds(body.input).find((id) => unstored.has(String(id)));
    if (stale) return json(400, notFound(String(stale)));
    const next = script[Math.min(i++, script.length - 1)]!;
    // A factory for a body that breaks: a clone tees the stream, the tee reads
    // ahead, and the error then discards the frames it had not handed over.
    return typeof next === "function" ? next() : next.clone();
  };
  class TestAzure extends AzureOpenAIProvider {
    protected override endpoint(): ResponsesEndpoint {
      return { ...super.endpoint(), fetchImpl, sleep: async () => {}, random: () => 0 };
    }
  }
  const provider = new TestAzure("gpt-x", {
    endpoint: "https://azure.example",
    apiKey: "k",
    maxRetries: 2,
  });
  return { provider, bodies, unstored };
}

describe("a failed step's reasoning on the next turn (Agent, Azure provider)", () => {
  test("a rate-limited attempt, then a retry cut off mid-reasoning: the next turn answers", async () => {
    const server = azure([
      json(429, { error: { message: "Rate limit exceeded.", code: "429" } }),
      () => sse(reasoningFrames("rs_cut"), "drop"),
      sse(answerFrames("Here you go.")),
    ]);
    // The response that streamed `rs_cut` never completed, so it was never
    // stored: replaying the id is what Azure refuses.
    server.unstored.add("rs_cut");
    const agent = Agent.create({ name: "main", provider: server.provider });

    const first = await agent.stream({ messages: [], turn: { text: "Build it." } }).result();
    expect(first.finishReason).toBe("error");
    // As the thread stores it: JSON, with the cut reasoning part on it.
    const stored: AgentMessage[] = JSON.parse(JSON.stringify(first.messages));
    const failed = stored.find((message) => message.role === "assistant")!;
    expect(failed.finishReason).toBe("error");
    expect(failed.content).toContainEqual(expect.objectContaining({ type: "reasoning", id: "rs_cut" }));
    const sentBefore = server.bodies.length;

    const second = await agent.stream({ messages: stored, turn: { text: "Try again." } }).result();

    expect(second.finishReason).toBe("stop");
    // One request, and it does not name the reasoning of the cut response.
    expect(server.bodies.length - sentBefore).toBe(1);
    expect(reasoningIds(server.bodies.at(-1)!.input)).toEqual([]);
  });

  test("a stored thread holding reasoning from a failed attempt answers on the first request", async () => {
    const server = azure([sse(answerFrames("Fine."))]);
    server.unstored.add("rs_failed");
    const agent = Agent.create({ name: "main", provider: server.provider });
    const thread: AgentMessage[] = [
      user("u1", "Build it."),
      assistant(
        "a1",
        "error",
        { type: "reasoning", id: "rs_failed", text: "Planning the page." },
        { type: "text", text: "Starting on" },
      ),
    ];

    const result = await agent.stream({ messages: thread, turn: { text: "Go on." } }).result();

    expect(result.finishReason).toBe("stop");
    expect(server.bodies).toHaveLength(1);
    expect(reasoningIds(server.bodies[0]!.input)).toEqual([]);
  });

  test("reasoning the API has lost from a finished step is dropped on retry, and the turn answers", async () => {
    const server = azure([sse(answerFrames("Fine."))]);
    server.unstored.add("rs_expired");
    const agent = Agent.create({ name: "main", provider: server.provider });
    const thread: AgentMessage[] = [
      user("u1", "Build it."),
      assistant("a1", "stop", { type: "reasoning", id: "rs_expired" }, { type: "text", text: "Built." }),
    ];

    const result = await agent.stream({ messages: thread, turn: { text: "Now the footer." } }).result();

    expect(result.finishReason).toBe("stop");
    expect(server.bodies).toHaveLength(2);
    expect(reasoningIds(server.bodies[0]!.input)).toEqual(["rs_expired"]);
    expect(reasoningIds(server.bodies[1]!.input)).toEqual([]);
  });
});
