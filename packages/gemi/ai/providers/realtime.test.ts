import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AzureOpenAIProvider, OpenAIProvider } from "../AgentProvider";
import { addUsage, emptyUsage } from "../runtime";
import { s } from "../Schema";
import { RealtimeRequestError, toRealtimeUsage, toVendorSession } from "./realtime";
import { parseRealtimeEvent, type RealtimeEvent, type WebSocketLike } from "./sideband";

/**
 * Realtime calls against the documented protocol (#921).
 *
 * NOTHING HERE TALKED TO A LIVE VENDOR. The fixtures under `__fixtures__/realtime-*`
 * follow OpenAI's GA Realtime documentation (the unified-interface call, the
 * `call_id` sideband, the `response.done` usage shape) with made-up ids and
 * numbers. Azure's side is the same protocol on `/openai/v1/realtime`, which is
 * what its GA docs describe and what has not been measured yet — see
 * `azureRealtimeTarget`.
 */

const FIXTURES = join(import.meta.dirname, "__fixtures__");
const SDP_ANSWER = readFileSync(join(FIXTURES, "realtime-call-answer.sdp"), "utf8");
const SIDEBAND = readFileSync(join(FIXTURES, "realtime-sideband.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean);
const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";

type Call = { url: string; init: RequestInit };

function stubFetch(
  respond: (url: string, init: RequestInit) => Response = () =>
    new Response(SDP_ANSWER, {
      status: 201,
      headers: { location: "/v1/realtime/calls/rtc_fixture123", "content-type": "application/sdp" },
    }),
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as unknown as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

/** Azure's documented server-proxied flow: client_secrets, then calls. */
function azureVendor(url: string): Response {
  if (url.includes("/client_secrets")) {
    return new Response(
      JSON.stringify({ value: "ek_azure", expires_at: 1790000060, session: {} }),
      { status: 200 },
    );
  }
  return new Response(SDP_ANSWER, {
    status: 201,
    headers: { location: "/openai/v1/realtime/calls/rtc_az1", "content-type": "application/sdp" },
  });
}

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe("RealtimeClient.createCall", () => {
  test("posts the offer and the session as multipart with the server key, and answers the SDP and call id", async () => {
    const calls = stubFetch();
    const realtime = OpenAIProvider.model("gpt-realtime-mini", { apiKey: "sk-test" }).realtime;

    const result = await realtime.createCall({
      sdp: OFFER,
      safetyIdentifier: "user-hash",
      session: {
        instructions: "Be brief.",
        voice: "marin",
        tools: [
          {
            name: "ask_builder",
            description: "Delegate a change.",
            parameters: s.object({ request: s.string() }),
          },
        ],
        turnDetection: { type: "semantic_vad", eagerness: "auto" },
        transcription: { model: "gpt-4o-mini-transcribe" },
        noiseReduction: "near_field",
      },
    });

    expect(result).toEqual({ sdpAnswer: SDP_ANSWER, callId: "rtc_fixture123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headersOf(calls[0]!).authorization).toBe("Bearer sk-test");
    expect(headersOf(calls[0]!)["OpenAI-Safety-Identifier"]).toBe("user-hash");

    const form = calls[0]!.init.body as FormData;
    expect(form.get("sdp")).toBe(OFFER);
    const session = JSON.parse(String(form.get("session")));
    expect(session).toEqual({
      type: "realtime",
      model: "gpt-realtime-mini",
      instructions: "Be brief.",
      tools: [
        {
          type: "function",
          name: "ask_builder",
          description: "Delegate a change.",
          parameters: expect.objectContaining({
            type: "object",
            properties: { request: expect.objectContaining({ type: "string" }) },
          }),
        },
      ],
      audio: {
        input: {
          turn_detection: { type: "semantic_vad", eagerness: "auto" },
          transcription: { model: "gpt-4o-mini-transcribe" },
          noise_reduction: { type: "near_field" },
        },
        output: { voice: "marin" },
      },
    });
  });

  test("Azure: the documented flow by default — a client secret minted with api-key on /openai/v1 whatever the api-version, then the raw SDP with that secret", async () => {
    const calls = stubFetch(azureVendor);
    const realtime = AzureOpenAIProvider.model("gpt-realtime-mini", {
      endpoint: "https://res.openai.azure.com/openai",
      apiKey: "az-key",
      apiVersion: "2025-04-01-preview",
      deployment: "voice-prod",
    }).realtime;

    const result = await realtime.createCall({
      sdp: OFFER,
      safetyIdentifier: "user-hash",
      session: { instructions: "Be brief." },
    });
    expect(result).toEqual({ sdpAnswer: SDP_ANSWER, callId: "rtc_az1" });

    expect(calls.map((c) => c.url)).toEqual([
      "https://res.openai.azure.com/openai/v1/realtime/client_secrets",
      "https://res.openai.azure.com/openai/v1/realtime/calls",
    ]);
    expect(headersOf(calls[0]!)["api-key"]).toBe("az-key");
    expect(JSON.parse(String(calls[0]!.init.body)).session).toEqual({
      type: "realtime",
      model: "voice-prod",
      instructions: "Be brief.",
    });
    // the call itself: the ephemeral secret, never the resource key
    const callHeaders = headersOf(calls[1]!);
    expect(callHeaders.authorization).toBe("Bearer ek_azure");
    expect(callHeaders["api-key"]).toBeUndefined();
    expect(callHeaders["content-type"]).toBe("application/sdp");
    expect(callHeaders["OpenAI-Safety-Identifier"]).toBe("user-hash");
    expect(calls[1]!.init.body).toBe(OFFER);
  });

  test("Azure: the unified multipart shape on request, and webrtcfilter=on", async () => {
    const calls = stubFetch(azureVendor);
    const realtime = AzureOpenAIProvider.model("gpt-realtime-mini", {
      endpoint: "https://res.openai.azure.com",
      apiKey: "az-key",
      deployment: "voice-prod",
    }).realtime;

    await realtime.createCall({ sdp: OFFER, flow: "unified", webrtcFilter: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://res.openai.azure.com/openai/v1/realtime/calls?webrtcfilter=on",
    );
    expect(headersOf(calls[0]!)["api-key"]).toBe("az-key");
    const session = JSON.parse(String((calls[0]!.init.body as FormData).get("session")));
    expect(session).toEqual({ type: "realtime", model: "voice-prod" });
  });

  test("Azure with Entra: a token minted per request", async () => {
    const calls = stubFetch(azureVendor);
    let n = 0;
    const realtime = AzureOpenAIProvider.model("gpt-realtime-mini", {
      resourceName: "res",
      getToken: async () => `token-${++n}`,
    }).realtime;

    await realtime.createCall({ sdp: OFFER });
    await realtime.createCall({ sdp: OFFER });

    expect(calls[0]!.url).toBe(
      "https://res.cognitiveservices.azure.com/openai/v1/realtime/client_secrets",
    );
    expect(headersOf(calls[0]!).authorization).toBe("Bearer token-1");
    expect(headersOf(calls[1]!).authorization).toBe("Bearer ek_azure");
    expect(headersOf(calls[2]!).authorization).toBe("Bearer token-2");
  });

  test("a session's model overrides the provider's", async () => {
    const calls = stubFetch();
    await OpenAIProvider.model("gpt-realtime-mini", { apiKey: "k" }).realtime.createCall({
      sdp: OFFER,
      session: { model: "gpt-realtime" },
    });
    const session = JSON.parse(String((calls[0]!.init.body as FormData).get("session")));
    expect(session.model).toBe("gpt-realtime");
  });

  test("a vendor error is a RealtimeRequestError with the normalized code and the status", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "Invalid SDP offer.", type: "invalid_request_error" },
          }),
          { status: 400 },
        ),
    );
    const error = await OpenAIProvider.model("gpt-realtime-mini", { apiKey: "k" })
      .realtime.createCall({ sdp: "nope" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(RealtimeRequestError);
    expect(error.status).toBe(400);
    expect(error.code).toBe("provider_error");
    expect(error.retryable).toBe(false);
  });

  test("a 503 is retried, since no call was made", async () => {
    let n = 0;
    const calls = stubFetch(() =>
      ++n === 1
        ? new Response("busy", { status: 503 })
        : new Response(SDP_ANSWER, {
            status: 201,
            headers: { location: "/v1/realtime/calls/rtc_2" },
          }),
    );
    const result = await OpenAIProvider.model("gpt-realtime-mini", {
      apiKey: "k",
    }).realtime.createCall({
      sdp: OFFER,
    });
    expect(calls).toHaveLength(2);
    expect(result.callId).toBe("rtc_2");
  });

  test("an answer with no Location is refused rather than handing back a call nobody can control", async () => {
    stubFetch(() => new Response(SDP_ANSWER, { status: 201 }));
    const error = await OpenAIProvider.model("gpt-realtime-mini", { apiKey: "k" })
      .realtime.createCall({ sdp: OFFER })
      .catch((e) => e);
    expect(error).toBeInstanceOf(RealtimeRequestError);
    expect(error.message).toMatch(/Location/);
  });
});

describe("RealtimeClient.clientSecret / hangup", () => {
  test("client secrets: expires_after and the mapped session", async () => {
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            value: "ek_123",
            expires_at: 1790000600,
            session: { type: "realtime" },
          }),
          { status: 200 },
        ),
    );
    const secret = await OpenAIProvider.model("gpt-realtime-mini", {
      apiKey: "k",
    }).realtime.clientSecret({
      ttlSeconds: 120,
      session: { voice: "marin" },
    });
    expect(secret).toEqual({
      value: "ek_123",
      expiresAt: 1790000600,
      session: { type: "realtime" },
      callsUrl: "https://api.openai.com/v1/realtime/calls",
    });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      expires_after: { anchor: "created_at", seconds: 120 },
      session: {
        type: "realtime",
        model: "gpt-realtime-mini",
        audio: { output: { voice: "marin" } },
      },
    });
  });

  test("client secrets: a ttl outside 10–7200 is refused before any request", async () => {
    const calls = stubFetch();
    const realtime = OpenAIProvider.model("gpt-realtime-mini", { apiKey: "k" }).realtime;
    await expect(realtime.clientSecret({ ttlSeconds: 5 })).rejects.toThrow(RangeError);
    await expect(realtime.clientSecret({ ttlSeconds: 7201 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  test("hangup posts to the call, and a 404 that says the call is gone is not an error", async () => {
    let answer = () => new Response(null, { status: 200 });
    const calls = stubFetch(() => answer());
    const realtime = AzureOpenAIProvider.model("gpt-realtime-mini", {
      endpoint: "https://res.openai.azure.com",
      apiKey: "k",
    }).realtime;
    await realtime.hangup("rtc_1");
    expect(calls[0]!.url).toBe(
      "https://res.openai.azure.com/openai/v1/realtime/calls/rtc_1/hangup",
    );
    answer = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "call_not_found",
            message: "Call rtc_1 not found.",
            type: "invalid_request_error",
          },
        }),
        { status: 404 },
      );
    await expect(realtime.hangup("rtc_1")).resolves.toBeUndefined();
  });

  test("a route-level 404 on hangup is an error, not 'already over'", async () => {
    let answer = () =>
      new Response(JSON.stringify({ error: { code: "404", message: "Resource not found" } }), {
        status: 404,
      });
    stubFetch(() => answer());
    const realtime = AzureOpenAIProvider.model("gpt-realtime-mini", {
      endpoint: "https://res.openai.azure.com",
      apiKey: "k",
    }).realtime;
    await expect(realtime.hangup("rtc_1")).rejects.toMatchObject({ status: 404 });
    answer = () => new Response(null, { status: 404 });
    await expect(realtime.hangup("rtc_1")).rejects.toBeInstanceOf(RealtimeRequestError);
  });
});

describe("toVendorSession", () => {
  test("null turn detection is sent as null (push-to-talk), and vendor fields win last", () => {
    expect(
      toVendorSession(
        {
          turnDetection: null,
          toolChoice: { name: "ask_builder" },
          outputModalities: ["audio"],
          maxOutputTokens: 512,
          vendor: { tracing: "auto" },
        },
        undefined,
      ),
    ).toEqual({
      type: "realtime",
      output_modalities: ["audio"],
      max_output_tokens: 512,
      tool_choice: { type: "function", name: "ask_builder" },
      audio: { input: { turn_detection: null } },
      tracing: "auto",
    });
  });

  test("server_vad fields are mapped to the vendor's names", () => {
    expect(
      toVendorSession({
        turnDetection: {
          type: "server_vad",
          silenceDurationMs: 600,
          idleTimeoutMs: 120_000,
          createResponse: false,
        },
      }),
    ).toEqual({
      type: "realtime",
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            silence_duration_ms: 600,
            idle_timeout_ms: 120_000,
            create_response: false,
          },
        },
      },
    });
  });
});

describe("realtime usage", () => {
  const done = JSON.parse(SIDEBAND.find((line) => line.includes('"response.done"'))!);

  test("response.done's usage maps onto Usage with the audio breakdown", () => {
    expect(toRealtimeUsage(done.response.usage)).toEqual({
      inputTokens: 1210,
      outputTokens: 132,
      totalTokens: 1342,
      cachedInputTokens: 896,
      audioInputTokens: 200,
      cachedAudioInputTokens: 64,
      audioOutputTokens: 92,
    });
  });

  test("addUsage sums the audio fields and leaves them off a text-only total", () => {
    const usage = toRealtimeUsage(done.response.usage);
    const total = addUsage(addUsage(emptyUsage(), usage), usage);
    expect(total.audioInputTokens).toBe(400);
    expect(total.cachedAudioInputTokens).toBe(128);
    expect(total.audioOutputTokens).toBe(184);
    expect(addUsage(emptyUsage(), { inputTokens: 1, outputTokens: 1, totalTokens: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });
  });
});

// --- the sideband ------------------------------------------------------------

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  closedWith?: { code?: number; reason?: string };
  private handlers: Record<string, ((event: any) => void)[]> = {};

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    FakeSocket.all.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send before open");
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.serverClose(code ?? 1000, reason ?? "");
  }

  // driven by the test
  serverOpen(): void {
    this.readyState = 1;
    this.fire("open", {});
  }
  serverSend(line: string): void {
    this.fire("message", { data: line });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  private fire(type: string, event: any): void {
    for (const h of this.handlers[type] ?? []) h(event);
  }
}

const factory = (url: string, init: { headers: Record<string, string> }) =>
  new FakeSocket(url, init.headers);

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function collect(iter: AsyncIterable<RealtimeEvent>): Promise<RealtimeEvent[]> {
  const out: RealtimeEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("RealtimeSideband", () => {
  test("opens wss with the call id and the server credential, queues sends until open, and yields the call's events", async () => {
    FakeSocket.all = [];
    const sideband = OpenAIProvider.model("gpt-realtime-mini", {
      apiKey: "sk-test",
    }).realtime.sideband("rtc_fixture123", { webSocket: factory });
    const events = collect(sideband);
    sideband.addNote("The user selected the hero.");
    await flush();

    const socket = FakeSocket.all[0]!;
    expect(socket.url).toBe("wss://api.openai.com/v1/realtime?call_id=rtc_fixture123");
    expect(socket.headers.authorization).toBe("Bearer sk-test");

    socket.serverOpen();
    await sideband.ready;
    expect(socket.sent).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "The user selected the hero." }],
        },
      },
    ]);

    for (const line of SIDEBAND) socket.serverSend(line);
    socket.serverSend("not json");
    socket.serverClose(1000, "call ended");

    const received = await events;
    const types = received.map((e) => e.type);
    expect(types).toEqual([
      "session.created",
      "input_audio_buffer.speech_started",
      "input_audio_buffer.speech_stopped",
      "input_audio_buffer.committed",
      "conversation.item.input_audio_transcription.delta",
      "conversation.item.input_audio_transcription.completed",
      "response.created",
      "response.output_audio_transcript.delta",
      "response.function_call_arguments.done",
      "response.done",
      // the beta name, renamed to the GA one
      "response.output_audio_transcript.delta",
      // unknown to gemi's types, passed through as itself
      "rate_limits.updated",
      "error",
      "sideband.closed",
    ]);

    const call = received.find((e) => e.type === "response.function_call_arguments.done") as any;
    expect(call).toMatchObject({ call_id: "call_abc", name: "ask_builder" });
    expect(JSON.parse(call.arguments)).toEqual({ request: "Make the hero section darker." });
    const done = received.find((e) => e.type === "response.done") as any;
    expect(done.usage).toMatchObject({ audioInputTokens: 200, audioOutputTokens: 92 });
    expect(received.at(-1)).toEqual({
      type: "sideband.closed",
      code: 1000,
      reason: "call ended",
      byClient: false,
    });
    await expect(sideband.closed).resolves.toMatchObject({ code: 1000, byClient: false });
  });

  test("Azure: the sideband is wss on /openai/v1/realtime with api-key", async () => {
    FakeSocket.all = [];
    const sideband = AzureOpenAIProvider.model("gpt-realtime-mini", {
      endpoint: "https://res.openai.azure.com/",
      apiKey: "az-key",
    }).realtime.sideband("rtc_1", { webSocket: factory });
    await flush();
    expect(FakeSocket.all[0]!.url).toBe(
      "wss://res.openai.azure.com/openai/v1/realtime?call_id=rtc_1",
    );
    expect(FakeSocket.all[0]!.headers["api-key"]).toBe("az-key");
    sideband.close();
  });

  test("the helpers send the documented client events", async () => {
    FakeSocket.all = [];
    const sideband = OpenAIProvider.model("m", { apiKey: "k" }).realtime.sideband("rtc_1", {
      webSocket: factory,
    });
    await flush();
    FakeSocket.all[0]!.serverOpen();
    sideband.functionOutput("call_abc", { ok: true, text: "Done." });
    sideband.createResponse({ instructions: "Say it in one sentence.", toolChoice: "none" });
    sideband.createResponse();
    sideband.cancelResponse();
    sideband.updateSession({ instructions: "New.", turnDetection: null });
    expect(FakeSocket.all[0]!.sent).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_abc",
          output: '{"ok":true,"text":"Done."}',
        },
      },
      {
        type: "response.create",
        response: { instructions: "Say it in one sentence.", tool_choice: "none" },
      },
      { type: "response.create" },
      { type: "response.cancel" },
      // no model on an update: a live call's model is not changed
      {
        type: "session.update",
        session: {
          type: "realtime",
          instructions: "New.",
          audio: { input: { turn_detection: null } },
        },
      },
    ]);
    sideband.close();
  });

  test("an abnormal close re-opens by call id, flushes what was queued, and says so", async () => {
    FakeSocket.all = [];
    const sideband = OpenAIProvider.model("m", { apiKey: "k" }).realtime.sideband("rtc_1", {
      webSocket: factory,
      reconnect: { attempts: 2, delayMs: 1 },
    });
    const seen: RealtimeEvent[] = [];
    sideband.on((e) => seen.push(e));
    await flush();
    FakeSocket.all[0]!.serverOpen();
    FakeSocket.all[0]!.serverClose(1006);
    sideband.addNote("queued while down");
    await new Promise((r) => setTimeout(r, 10));
    await flush();
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]!.url).toBe("wss://api.openai.com/v1/realtime?call_id=rtc_1");
    FakeSocket.all[1]!.serverOpen();
    expect(FakeSocket.all[1]!.sent).toHaveLength(1);
    expect(seen).toEqual([{ type: "sideband.reconnected", attempt: 1 }]);
    sideband.close();
    await expect(sideband.closed).resolves.toMatchObject({ byClient: true });
  });

  test("a sideband that never opens gives up after its attempts: ready rejects and closed resolves", async () => {
    FakeSocket.all = [];
    const sideband = OpenAIProvider.model("m", { apiKey: "k" }).realtime.sideband("rtc_gone", {
      webSocket: factory,
      reconnect: { attempts: 1, delayMs: 1 },
    });
    await flush();
    FakeSocket.all[0]!.serverClose(1006, "404");
    await new Promise((r) => setTimeout(r, 10));
    await flush();
    FakeSocket.all[1]!.serverClose(1006, "404");
    await expect(sideband.ready).rejects.toThrow(/did not open/);
    await expect(sideband.closed).resolves.toEqual({
      type: "sideband.closed",
      code: 1006,
      reason: "404",
      byClient: false,
    });
    expect(FakeSocket.all).toHaveLength(2);
  });

  test("hangup ends the call over HTTP and closes the socket", async () => {
    FakeSocket.all = [];
    const calls = stubFetch(() => new Response(null, { status: 200 }));
    const sideband = OpenAIProvider.model("m", { apiKey: "k" }).realtime.sideband("rtc_1", {
      webSocket: factory,
    });
    await flush();
    FakeSocket.all[0]!.serverOpen();
    await sideband.hangup();
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/realtime/calls/rtc_1/hangup");
    expect(FakeSocket.all[0]!.closedWith).toEqual({ code: 1000, reason: "hangup" });
    await expect(sideband.closed).resolves.toMatchObject({ byClient: true });
    // nothing is sent after the end
    sideband.addNote("late");
    expect(FakeSocket.all[0]!.sent).toEqual([]);
  });

  test("a refused hangup keeps the sideband open, since the call may still be running", async () => {
    FakeSocket.all = [];
    stubFetch(() => new Response(null, { status: 404 }));
    const sideband = OpenAIProvider.model("m", { apiKey: "k" }).realtime.sideband("rtc_1", {
      webSocket: factory,
    });
    await flush();
    FakeSocket.all[0]!.serverOpen();
    await expect(sideband.hangup()).rejects.toBeInstanceOf(RealtimeRequestError);
    expect(FakeSocket.all[0]!.closedWith).toBeUndefined();
    sideband.addNote("still metering");
    expect(FakeSocket.all[0]!.sent).toHaveLength(1);

    // once the vendor has closed it normally, the call is over and a refused
    // hangup is moot
    FakeSocket.all[0]!.serverClose(1000, "call ended");
    await sideband.closed;
    await expect(sideband.hangup()).resolves.toBeUndefined();
  });

  test("transcription usage is mapped apart from response usage: tokens or seconds", () => {
    const tokens = parseRealtimeEvent(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "Hi.",
        usage: {
          type: "tokens",
          input_tokens: 40,
          output_tokens: 5,
          total_tokens: 45,
          input_token_details: { text_tokens: 0, audio_tokens: 40 },
        },
      }),
    ) as any;
    expect(tokens.transcriptionUsage).toEqual({
      inputTokens: 40,
      outputTokens: 5,
      totalTokens: 45,
      audioInputTokens: 40,
    });
    expect(tokens.usage.type).toBe("tokens");
    const duration = parseRealtimeEvent(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u2",
        transcript: "Hi.",
        usage: { type: "duration", seconds: 2.5 },
      }),
    ) as any;
    expect(duration.transcriptionSeconds).toBe(2.5);
    expect(duration.transcriptionUsage).toBeUndefined();
  });

  test("parseRealtimeEvent ignores frames that are not events", () => {
    expect(parseRealtimeEvent("[]")).toBeUndefined();
    expect(parseRealtimeEvent('{"no":"type"}')).toBeUndefined();
    expect(parseRealtimeEvent(new Uint8Array([1]))).toBeUndefined();
  });
});
