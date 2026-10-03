import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ProviderEvent } from "../AgentProvider";
import type { AgentMessage } from "../types";
import { responsesEndpoint, streamResponses, type ResponsesEndpoint } from "./call";
import { ProviderHttpError } from "./errors";
import {
  MAX_FILE_REJECTION_RETRIES,
  rejectedFileIds,
  sentFiles,
  unreadableNote,
  withoutFiles,
} from "./fileRejection";
import type { FetchLike } from "./http";
import { buildResponsesRequest, toResponsesInput, type ResponsesRequest } from "./request";

/**
 * #684 against the bodies Azure actually answers. Every `azure-error-file-*`
 * fixture was recorded off a live resource (see `fileRejection.ts` for what
 * was sent to get each one), so these fail if the matching is written against
 * a shape the API does not use.
 */
const DIR = join(import.meta.dirname, "__fixtures__");
const recorded = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), "utf8"));

const CAPS = {
  reasoning: true,
  structuredOutput: true,
  fileInput: true,
  parallelToolCalls: true,
  toolSearch: true,
};

function user(id: string, ...content: AgentMessage["content"]): AgentMessage {
  return { id, role: "user", content, createdAt: "2026-10-01" };
}

/** A body whose blocks sit where the recording says the refused one was. */
function request(messages: AgentMessage[]): ResponsesRequest {
  return buildResponsesRequest({ messages }, { model: "gpt-6-sol", capabilities: CAPS });
}

// `input[2].content[1].file_id` — the third item, the second block, exactly the
// position the request that produced `azure-error-file-id-prefix.json` used.
const PREFIX_HISTORY: AgentMessage[] = [
  user("m1", { type: "text", text: "Say ok." }),
  {
    id: "m2",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    createdAt: "2026-10-01",
  },
  user(
    "m3",
    { type: "text", text: "read" },
    { type: "file", fileId: "file-e63f5ebf1ae8433389d9180a889509c5", name: "note.txt" },
  ),
];

describe("rejectedFileIds()", () => {
  test("Azure's `user_data` refusal names the block by path", () => {
    const body = request(PREFIX_HISTORY);
    const error = new ProviderHttpError(400, recorded("azure-error-file-id-prefix.json"));
    expect(rejectedFileIds(body, error)).toEqual(["file-e63f5ebf1ae8433389d9180a889509c5"]);
  });

  test("a path that does not land on a file block falls through to the ids", () => {
    // Same refusal, but the history moved: the path now points at a text
    // block. The id is still in the message, and still in the request.
    const body = request([PREFIX_HISTORY[2]!]);
    const error = new ProviderHttpError(400, recorded("azure-error-file-id-prefix.json"));
    expect(rejectedFileIds(body, error)).toEqual(["file-e63f5ebf1ae8433389d9180a889509c5"]);
  });

  test("missing files are read out of the message, every one of them", () => {
    const body = request([
      user(
        "m1",
        { type: "file", fileId: "assistant-AAAAAAAAAAAAAAAAAAAAAA", name: "a.pdf" },
        {
          type: "file",
          fileId: "assistant-BBBBBBBBBBBBBBBBBBBBBB",
          name: "b.png",
          mimeType: "image/png",
        },
        { type: "file", fileId: "assistant-fine", name: "c.pdf" },
      ),
    ]);
    const error = new ProviderHttpError(400, recorded("azure-error-files-not-found.json"));
    expect(rejectedFileIds(body, error)).toEqual([
      "assistant-AAAAAAAAAAAAAAAAAAAAAA",
      "assistant-BBBBBBBBBBBBBBBBBBBBBB",
    ]);
  });

  test("a deleted file reads as missing", () => {
    const body = request([
      user("m1", { type: "file", fileId: "assistant-AtMJA9FZWvCyVkyTKnVEyE", name: "gone.txt" }),
    ]);
    const error = new ProviderHttpError(400, recorded("azure-error-file-deleted.json"));
    expect(rejectedFileIds(body, error)).toEqual(["assistant-AtMJA9FZWvCyVkyTKnVEyE"]);
  });

  test("an id is matched whole, so a prefix of a refused id is not blamed", () => {
    const body = request([
      user("m1", { type: "file", fileId: "assistant-AtMJA9FZWv", name: "other.txt" }),
    ]);
    const error = new ProviderHttpError(400, recorded("azure-error-file-deleted.json"));
    expect(rejectedFileIds(body, error)).toEqual([]);
  });

  test("the wrong block for a type is found by extension when that settles it", () => {
    const parts = [
      { type: "file" as const, fileId: "assistant-png", name: "dot.png", mimeType: "text/plain" },
      {
        type: "file" as const,
        fileId: "assistant-pdf",
        name: "doc.pdf",
        mimeType: "application/pdf",
      },
    ];
    const body = request([user("m1", ...parts)]);
    const files = sentFiles([user("m1", ...parts)]);
    const error = new ProviderHttpError(400, recorded("azure-error-file-type.json"));
    // Both went out as `input_file`; only one is a .png.
    expect(rejectedFileIds(body, error, files)).toEqual(["assistant-png"]);
  });

  test("and is left alone when it does not", () => {
    const parts = [
      { type: "file" as const, fileId: "assistant-1", name: "a.png", mimeType: "text/plain" },
      { type: "file" as const, fileId: "assistant-2", name: "b.png", mimeType: "text/plain" },
    ];
    const body = request([user("m1", ...parts)]);
    const error = new ProviderHttpError(400, recorded("azure-error-file-type.json"));
    expect(rejectedFileIds(body, error, sentFiles([user("m1", ...parts)]))).toEqual([]);
  });

  test("errors that are not about a file in this request are not retried", () => {
    const body = request(PREFIX_HISTORY);
    expect(
      rejectedFileIds(
        body,
        new ProviderHttpError(404, recorded("azure-error-bad-deployment.json")),
      ),
    ).toEqual([]);
    expect(
      rejectedFileIds(
        body,
        new ProviderHttpError(500, recorded("azure-error-file-id-prefix.json")),
      ),
    ).toEqual([]);
    expect(rejectedFileIds(body, new TypeError("fetch failed"))).toEqual([]);
    // The refusal names a file this request does not hold.
    expect(
      rejectedFileIds(
        request([user("m1", { type: "text", text: "hi" })]),
        new ProviderHttpError(400, recorded("azure-error-files-not-found.json")),
      ),
    ).toEqual([]);
  });
});

describe("withoutFiles()", () => {
  test("swaps the refused block for a note and leaves the rest", () => {
    const body = request([
      user(
        "m1",
        { type: "text", text: "compare" },
        { type: "file", fileId: "bad", name: "q3.pdf" },
        { type: "file", fileId: "good", name: "q4.pdf" },
      ),
    ]);
    const files = sentFiles([user("m1", { type: "file", fileId: "bad", name: "q3.pdf" })]);
    const next = withoutFiles(body, new Set(["bad"]), files);
    expect(next.input[0]).toMatchObject({
      content: [
        { type: "input_text", text: "compare" },
        { type: "input_text", text: unreadableNote("q3.pdf") },
        { type: "input_file", file_id: "good" },
      ],
    });
    // The body that was sent is not rewritten under the caller.
    expect((body.input[0]!.content as unknown[])[1]).toEqual({
      type: "input_file",
      file_id: "bad",
    });
  });
});

describe("a part marked providerRejected", () => {
  test("is sent as the note, with the attachment line when there is one", () => {
    const input = toResponsesInput(
      [
        user("m1", {
          type: "file",
          fileId: "file-dead",
          name: "a.pdf",
          attachmentId: "gemi_att_1",
          providerRejected: true,
        }),
      ],
      CAPS,
    );
    const content = input[0]!.content as Record<string, unknown>[];
    expect(content.some((block) => "file_id" in block)).toBe(false);
    expect(content).toEqual([
      { type: "input_text", text: expect.stringContaining('id="gemi_att_1"') },
      { type: "input_text", text: unreadableNote("a.pdf") },
    ]);
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
      const events: ProviderEvent[] = [];
      for await (const event of streamResponses(endpoint, request(messages), {
        structuredOutput: false,
        files: sentFiles(messages),
      })) {
        events.push(event);
      }
      return events;
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const COMPLETED = new Response(
  [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
  ].join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

describe("streamResponses() and a refused file", () => {
  test("retries without the file, and says which one it dropped", async () => {
    const h = harness([json(400, recorded("azure-error-file-id-prefix.json")), COMPLETED]);
    const events = await h.run(PREFIX_HISTORY);

    expect(h.bodies).toHaveLength(2);
    expect(JSON.stringify(h.bodies[1])).not.toContain("file-e63f5ebf1ae8433389d9180a889509c5");
    expect(h.bodies[1]!.input[2]).toMatchObject({
      content: [
        { type: "input_text", text: "read" },
        { type: "input_text", text: unreadableNote("note.txt") },
      ],
    });
    expect(events[0]).toMatchObject({
      type: "file-rejected",
      fileId: "file-e63f5ebf1ae8433389d9180a889509c5",
      status: 400,
      message: expect.stringContaining("Expected an ID that begins with 'assistant'"),
    });
    expect(events.map((event) => event.type)).toEqual(["file-rejected", "text-delta", "finish"]);
  });

  test("clears several bad ids that are named one per refusal", async () => {
    const second = {
      error: {
        message:
          "Invalid 'input[0].content[1].file_id': 'file-second'. Expected an ID that begins with 'assistant'.",
        type: "invalid_request_error",
        param: "input[0].content[1].file_id",
        code: "invalid_value",
      },
    };
    const first = structuredClone(second);
    first.error.message = first.error.message.replace("file-second", "file-first");
    first.error.param = "input[0].content[0].file_id";
    const h = harness([json(400, first), json(400, second), COMPLETED]);
    const events = await h.run([
      user(
        "m1",
        { type: "file", fileId: "file-first", name: "a.txt" },
        { type: "file", fileId: "file-second", name: "b.txt" },
      ),
    ]);

    expect(h.bodies).toHaveLength(3);
    expect(events.filter((event) => event.type === "file-rejected")).toHaveLength(2);
    expect(events[events.length - 1]).toMatchObject({ type: "finish", reason: "stop" });
  });

  test("gives up after the cap and reports the last refusal as the error", async () => {
    const refusals = Array.from({ length: MAX_FILE_REJECTION_RETRIES + 1 }, (_, i) =>
      json(400, {
        error: {
          message: `Files [file-${i}] were not found.`,
          type: "invalid_request_error",
          param: null,
          code: null,
        },
      }),
    );
    const h = harness(refusals);
    const parts = refusals.map((_, i) => ({ type: "file" as const, fileId: `file-${i}` }));
    const events = await h.run([user("m1", { type: "text", text: "hi" }, ...parts)]);

    expect(h.bodies).toHaveLength(MAX_FILE_REJECTION_RETRIES + 1);
    expect(events.filter((event) => event.type === "file-rejected")).toHaveLength(
      MAX_FILE_REJECTION_RETRIES,
    );
    expect(events.slice(-2)).toMatchObject([
      { type: "error", status: 400 },
      { type: "finish", reason: "error" },
    ]);
  });

  test("does not retry a refusal that blames a file it already dropped", async () => {
    const h = harness([json(400, recorded("azure-error-file-id-prefix.json"))]);
    const events = await h.run(PREFIX_HISTORY);
    // Same answer twice: the second attempt has no such block, so there is
    // nothing left to take out and the error goes through as it is.
    expect(h.bodies).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(["file-rejected", "error", "finish"]);
  });

  test("any other 400 fails the call exactly as before", async () => {
    const h = harness([json(400, recorded("openai-error-bad-model.json"))]);
    const events = await h.run(PREFIX_HISTORY);
    expect(h.bodies).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["error", "finish"]);
  });
});
