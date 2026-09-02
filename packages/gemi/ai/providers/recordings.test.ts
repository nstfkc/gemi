import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ProviderEvent } from "../AgentProvider";
import { ProviderHttpError, normalizeProviderError } from "./errors";
import { parseResponsesStream } from "./stream";

/**
 * THE PARSER AGAINST REAL TRAFFIC.
 *
 * Every test below reads a file recorded off the live API. No key, no network,
 * so it runs in CI like any other test — and unlike a hand-written fixture, it
 * fails when the API changes rather than only when the parser does. That is the
 * whole reason these exist: both of the bugs this file was created to pin
 * survived a full suite of fixtures written from the documented shapes, because
 * a fixture written from a spec tests the spec.
 *
 * The two that were wrong: `tool_search_output.tools` holds namespaces, not
 * functions, so the parser reported the group's name as a tool name; and a
 * namespaced call comes back with a flat `name` plus a separate `namespace`,
 * which nothing pinned. Captured off `https://api.openai.com/v1/responses` and
 * off a live Azure resource.
 *
 * NO KEYS, NO HOSTS. Every file here is a response body, never a request, so
 * no credential was ever in one; each was also grepped for both API keys, the
 * resource name and the configured endpoint before being committed. Response
 * ids (`resp_…`, `call_…`) are left exactly as recorded — they name a
 * completed request on someone's account and are useless to anyone else, and
 * rewriting them is how a fixture stops being a recording.
 *
 * OFFLINE, ALWAYS. Reading these needs no key and no network, so the default
 * suite runs everywhere. Nothing in this package calls the API during `vitest
 * run`; a test that wants to is a live test another slice owns.
 *
 * The catalogue, with what each one is here to prove:
 *
 *   openai-tool-search.sse         gpt-5.4 searching a deferred `crm` namespace
 *                                  and calling `getOrder`. The namespace tree,
 *                                  the flat call name, the `tsc_`/`tso_` id
 *                                  pair with nothing linking them.
 *   openai-text.sse                plain prose.
 *   openai-reasoning.sse           `reasoning.effort: medium` with a summary —
 *                                  87 `reasoning_summary_text.delta` frames and
 *                                  a non-zero `reasoning_tokens`.
 *   openai-structured.sse          a strict `json_schema` answer, which arrives
 *                                  down the same `output_text.delta` channel
 *                                  prose does.
 *   openai-parallel-tools.sse      two `getWeather` calls in one turn, which is
 *                                  where a parser that keys on the wrong id
 *                                  merges them.
 *   openai-error-oversized.sse     a 3MB input. NOT an HTTP error: the call
 *                                  answers 200 and fails mid-stream with
 *                                  `context_length_exceeded`.
 *   openai-error-bad-model.json    400, `model_not_found`.
 *   openai-error-tool-search-unsupported.json
 *                                  400 from gpt-5.1 — the measurement the
 *                                  toolSearch capability boundary is drawn on.
 *   azure-text.sse                 the same prose, plus the `content_filters`
 *                                  array Azure sends on every response with
 *                                  nothing wrong.
 *   azure-content-filtered.sse     a prompt that trips the filter: 200,
 *                                  `blocked:true`, and `response.incomplete`
 *                                  with reason `content_filter`.
 *   azure-parallel-tools.sse       the same two calls, to show Azure's stream
 *                                  is the OpenAI one.
 *   azure-error-oversized.sse      the same mid-stream context failure.
 *   azure-error-bad-deployment.json  404, `DeploymentNotFound` — Azure's
 *                                  spelling of a bad model id, and a different
 *                                  status to OpenAI's.
 */
const DIR = join(import.meta.dirname, "__fixtures__");

function fixture(name: string): string {
  return readFileSync(join(DIR, name), "utf8");
}

/**
 * A recording as the parser sees it off a socket: many chunks, split on no
 * boundary in particular. `parseResponsesStream` takes an iterable of strings,
 * and handing it the whole file at once would exercise a case that never
 * happens in production.
 */
function fixtureChunks(name: string, size = 64): string[] {
  const raw = fixture(name);
  const chunks: string[] = [];
  for (let i = 0; i < raw.length; i += size) chunks.push(raw.slice(i, i + size));
  return chunks;
}

/** The parsed `data:` payloads, for a test that wants to assert about the
 *  recording itself rather than about what the parser did with it. */
function fixtureFrames(name: string): Record<string, any>[] {
  const frames: Record<string, any>[] = [];
  for (const line of fixture(name).split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      frames.push(JSON.parse(data));
    } catch {
      // A recording is not required to be all JSON; a frame we cannot read is
      // not one a test is asking about.
    }
  }
  return frames;
}

async function parse(
  name: string,
  options?: { structuredOutput?: boolean },
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of parseResponsesStream(fixtureChunks(name), options)) out.push(event);
  return out;
}

function text(events: ProviderEvent[]): string {
  return events
    .filter((e) => e.type === "text-delta")
    .map((e) => e.delta)
    .join("");
}

describe("tool search, against the recorded stream", () => {
  /**
   * THE BUG THIS FILE EXISTS FOR. `tool_search_output.tools` is an array of
   * namespaces, each holding the functions that loaded. Reading `name` off the
   * top level reported `["crm"]` — the group — as though it were the tools,
   * and every hand-written fixture agreed with it because they were written to.
   */
  test("reports the functions that loaded, not the namespace they came from", async () => {
    const searches = (await parse("openai-tool-search.sse")).filter(
      (e) => e.type === "tool-search",
    );

    expect(searches).toEqual([
      { type: "tool-search", loaded: ["listOrders", "getOrder"], namespaces: ["crm"] },
    ]);
  });

  /**
   * The recording is what makes this assertion worth anything: it says the
   * shape the parser has to recurse into is really there, so a test that
   * stopped recursing could not pass by agreeing with a fixture someone wrote
   * to match the code.
   */
  test("the recording really does nest functions one level down", () => {
    const outputs = fixtureFrames("openai-tool-search.sse")
      .filter((f) => f.type === "response.output_item.done")
      .map((f) => f.item)
      .filter((item) => item.type === "tool_search_output");

    expect(outputs).toHaveLength(1);
    const tools = outputs[0]!.tools;
    expect(tools.map((t: any) => [t.type, t.name])).toEqual([["namespace", "crm"]]);
    expect(tools[0].tools.map((t: any) => t.name)).toEqual(["listOrders", "getOrder"]);
  });

  /**
   * The dedup that used to work by accident. The call item and the output item
   * have different ids, `call_id` is null on both, and neither carries
   * `tool_search_call_id` — so the key they are stored under can never
   * collide, and the pair collapses only because the call item carries the
   * query rather than results. This test pins the premise; if the API ever
   * starts putting results on the call item, it fails here rather than by
   * double-reporting in someone's UI.
   */
  test("nothing in the recording links the search call to its output", () => {
    const items = fixtureFrames("openai-tool-search.sse")
      .filter((f) => f.type === "response.output_item.done")
      .map((f) => f.item)
      .filter((item) => String(item.type).startsWith("tool_search"));

    expect(items.map((i) => i.type)).toEqual(["tool_search_call", "tool_search_output"]);
    expect(items[0]!.id).not.toBe(items[1]!.id);
    for (const item of items) {
      expect(item.call_id, item.type).toBeNull();
      expect(item.tool_search_call_id, item.type).toBeUndefined();
    }
    // The call item carries the query it ran, not what came back.
    expect(items[0]!.arguments).toEqual({ paths: ["crm"] });
    expect(items[0]!.tools).toBeUndefined();
  });

  test("reports one event from the real stream, despite that", async () => {
    const events = await parse("openai-tool-search.sse");
    expect(events.filter((e) => e.type === "tool-search")).toHaveLength(1);
  });

  /**
   * The other open question the recording answers. A call to a function inside
   * a namespace comes back with a FLAT name and a separate `namespace` field —
   * `{name: "getOrder", namespace: "crm"}`, never `"crm.getOrder"`. Using the
   * flat name was already right and nothing said so; qualifying it would break
   * every registry lookup in `Agent`, and this test is what stops someone
   * "fixing" that.
   */
  test("a namespaced call keeps a flat name and carries the namespace beside it", async () => {
    const calls = (await parse("openai-tool-search.sse")).filter((e) => e.type === "tool-call");

    expect(calls).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_rgFEIYVjWtONGlzl1gTmy46Y",
        name: "getOrder",
        args: '{"orderId":"4417"}',
        namespace: "crm",
      },
    ]);
  });

  test("the deltas of a namespaced call carry it too", async () => {
    const deltas = (await parse("openai-tool-search.sse")).filter(
      (e) => e.type === "tool-call-delta",
    );

    expect(deltas.length).toBeGreaterThan(1);
    for (const delta of deltas) {
      expect(delta).toMatchObject({ name: "getOrder", namespace: "crm" });
    }
  });

  /**
   * `namespace` is absent, not `undefined`, on a tool that was listed bare —
   * which is every tool in the parallel-call recording. A consumer spreading
   * the event into a stored part gets no key at all rather than a null one.
   */
  test("a bare tool gets no namespace key at all", async () => {
    const calls = (await parse("openai-parallel-tools.sse")).filter((e) => e.type === "tool-call");
    for (const call of calls) expect(Object.keys(call)).not.toContain("namespace");
  });
});

describe("the ordinary streams", () => {
  test("plain text arrives as text deltas and a stop with usage", async () => {
    const events = await parse("openai-text.sse");

    expect(text(events)).toBe("The invoice is paid.");
    expect(events.at(-1)).toEqual({
      type: "finish",
      reason: "stop",
      usage: {
        inputTokens: 15,
        outputTokens: 9,
        totalTokens: 24,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
    });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  /**
   * Reasoning arrives as `reasoning_summary_text.delta`, not as the
   * `reasoning_text.delta` the parser also accepts — worth pinning, because a
   * parser that only handled the second name would look correct against a
   * hand-written fixture and produce a long silence against the real model.
   */
  test("a reasoning stream yields reasoning deltas before its answer", async () => {
    const events = await parse("openai-reasoning.sse");
    const reasoning = events.filter((e) => e.type === "reasoning-delta");

    expect(reasoning.length).toBeGreaterThan(10);
    expect(reasoning.every((e) => typeof e.id === "string" && e.id.startsWith("rs_"))).toBe(true);
    // Every reasoning delta precedes every text delta.
    expect(events.findLastIndex((e) => e.type === "reasoning-delta")).toBeLessThan(
      events.findIndex((e) => e.type === "text-delta"),
    );
    expect(text(events)).toContain("10:02");

    const finish = events.at(-1);
    expect(finish).toMatchObject({ type: "finish", reason: "stop" });
    expect(finish!.type === "finish" && finish.usage.reasoningTokens).toBeGreaterThan(0);
  });

  /**
   * The whole reason `structuredOutput` is a parse option: a strict
   * `json_schema` answer comes down the SAME `response.output_text.delta`
   * channel prose does, and only the caller knows which it asked for. The one
   * recording proves both branches.
   */
  test("a structured answer is prose or output depending only on what was asked for", async () => {
    const asProse = await parse("openai-structured.sse");
    const asOutput = await parse("openai-structured.sse", { structuredOutput: true });

    expect(asProse.every((e) => e.type !== "output-delta")).toBe(true);
    expect(asOutput.every((e) => e.type !== "text-delta")).toBe(true);

    const json = asOutput
      .filter((e) => e.type === "output-delta")
      .map((e) => e.delta)
      .join("");
    expect(JSON.parse(json)).toEqual({
      orderId: "4021",
      shippedOn: "2026-02-11",
      city: "Berlin",
    });
  });

  /**
   * Two calls in one turn, which is where a parser that keys arguments on the
   * response instead of the item merges them into one call with both cities'
   * arguments concatenated.
   */
  test("parallel tool calls stay two calls with two ids", async () => {
    const calls = (await parse("openai-parallel-tools.sse")).filter((e) => e.type === "tool-call");

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.type === "tool-call" && JSON.parse(c.args).city)).toEqual([
      "Paris",
      "Tokyo",
    ]);
    expect(new Set(calls.map((c) => c.type === "tool-call" && c.toolCallId)).size).toBe(2);
  });

  test("Azure's stream is the same stream", async () => {
    const openai = await parse("openai-parallel-tools.sse");
    const azure = await parse("azure-parallel-tools.sse");

    const shape = (events: ProviderEvent[]) =>
      events.map((e) => (e.type === "tool-call" ? `${e.type}:${e.name}` : e.type));
    expect(shape(azure)).toEqual(shape(openai));
  });

  /**
   * The recordings are re-run a byte at a time. A frame boundary landing inside
   * a JSON string or between a CR and an LF is the normal case on a socket and
   * is invisible when a fixture arrives whole.
   */
  test("byte-at-a-time chunking produces an identical event sequence", async () => {
    for (const name of [
      "openai-tool-search.sse",
      "openai-parallel-tools.sse",
      "azure-content-filtered.sse",
    ]) {
      const whole: ProviderEvent[] = [];
      for await (const event of parseResponsesStream([fixture(name)])) whole.push(event);
      const byByte: ProviderEvent[] = [];
      for await (const event of parseResponsesStream(fixtureChunks(name, 1))) byByte.push(event);
      expect(byByte, name).toEqual(whole);
    }
  });
});

describe("Azure's content filter", () => {
  /**
   * `content_filters` is on EVERY Azure response, `blocked:false` and every
   * category safe. Mapping its presence — or any `filtered:true` inside it —
   * onto `content_filtered` would flag every Azure call gemi ever makes. This
   * is the test that says so, so the decision cannot quietly be reversed.
   */
  test("the array is present on a perfectly ordinary answer and means nothing", async () => {
    const filters = fixtureFrames("azure-text.sse")
      .map((f) => f.response?.content_filters)
      .filter(Boolean);

    expect(filters.length).toBeGreaterThan(0);
    for (const entry of filters.flat()) expect(entry.blocked).toBe(false);

    const events = await parse("azure-text.sse");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  /**
   * And what a real block looks like, which is nothing like an HTTP error: 200,
   * a polite refusal streamed as ordinary text, and `response.incomplete` with
   * `incomplete_details.reason` of `content_filter`. The old parser mapped
   * every `incomplete` that was not `max_output_tokens` to a clean `stop`, so a
   * blocked run read as a finished answer and the loop took another step.
   */
  test("a blocked prompt is an error, not the clean stop it used to look like", async () => {
    const blocked = fixtureFrames("azure-content-filtered.sse").find(
      (f) => f.type === "response.incomplete",
    );
    expect(blocked!.response.incomplete_details).toEqual({ reason: "content_filter" });

    const events = await parse("azure-content-filtered.sse");
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({
      type: "error",
      error: { code: "content_filtered", retryable: false },
    });
    // The detail comes off `content_filters`, because `incomplete_details`
    // carries the words `content_filter` and nothing else.
    expect(error!.type === "error" && error.error.message).toContain("violence (prompt)");
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  });
});

describe("the recorded failures", () => {
  /**
   * NOT AN HTTP ERROR, which is the surprise. A 3MB input is accepted, the
   * response streams, and it fails four frames in. A provider that only
   * normalized non-2xx bodies would report this as a stream that stopped for no
   * reason.
   */
  test("an oversized request fails mid-stream, not on the status line", async () => {
    for (const name of ["openai-error-oversized.sse", "azure-error-oversized.sse"]) {
      const events = await parse(name);
      expect(events, name).toEqual([
        {
          type: "error",
          error: {
            code: "context_length_exceeded",
            message: expect.stringContaining("context window"),
            retryable: false,
          },
        },
        { type: "finish", reason: "error", usage: expect.anything() },
      ]);
    }
  });

  /** A bad model id is a 400 on OpenAI and a 404 on Azure, with different codes
   *  and different words. Both have to land on the same thing an app branches
   *  on, which is the whole promise of `normalizeError`. */
  test("a bad model id normalizes the same either side", () => {
    const openai = normalizeProviderError(
      new ProviderHttpError(400, JSON.parse(fixture("openai-error-bad-model.json"))),
    );
    const azure = normalizeProviderError(
      new ProviderHttpError(404, JSON.parse(fixture("azure-error-bad-deployment.json"))),
    );

    expect(openai).toEqual({
      code: "provider_error",
      message: "The requested model 'gpt-5.9-turbo-does-not-exist' does not exist.",
      retryable: false,
    });
    expect(azure).toMatchObject({ code: "provider_error", retryable: false });
    expect(azure.message).toContain("deployment for this resource does not exist");
  });

  /**
   * How an over-guessed capability actually fails, which is the argument
   * `capabilities.ts` makes for guessing high: one 400 that names the parameter
   * it disliked, `param: "tools"`, so it normalizes to `invalid_tool_input`
   * rather than to a generic outage — an app is told its tools are the problem.
   */
  test("a model that cannot search for tools says so, and says which parameter", () => {
    const error = normalizeProviderError(
      new ProviderHttpError(400, JSON.parse(fixture("openai-error-tool-search-unsupported.json"))),
    );

    expect(error).toEqual({
      code: "invalid_tool_input",
      message: "Tool 'tool_search' is not supported with gpt-5.1.",
      retryable: false,
    });
  });
});

/**
 * A recording is only safe to commit because it is a RESPONSE body — a request
 * carries the credential, a response never does. That is an argument, not a
 * guarantee, so it is checked: the next person to add a fixture here gets a red
 * test rather than a code review that might catch it.
 *
 * Response ids are deliberately not caught by any of this. `resp_08945c…` and
 * `call_rgFEIYVj…` name a completed request on an account nobody else can
 * reach, and scrubbing them would make the file a paraphrase of a recording
 * instead of a recording.
 */
describe("the fixtures themselves", () => {
  const files = readdirSync(DIR);

  test("there are recordings to test with", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test.each(files)("%s carries nothing key-shaped", (name) => {
    const raw = readFileSync(join(DIR, name), "utf8");

    // An OpenAI secret or project key, and an Azure key (32 hex or a long
    // base64ish run) presented as one.
    expect(raw).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
    expect(raw).not.toMatch(/\b(api-key|authorization|x-api-key)\b\s*[:=]/i);
    expect(raw).not.toMatch(/\bBearer\s+\S+/);
    // No live host either: an endpoint names someone's resource, and a fixture
    // does not need one to be a fixture.
    expect(raw).not.toMatch(/[a-z0-9-]+\.(?:openai|cognitiveservices)\.azure\.com/i);
  });
});
