import { afterEach, describe, expect, test, vi } from "vitest";

import { AzureOpenAIProvider, OpenAIProvider } from "../AgentProvider";
import { DEFAULT_TRANSCRIPTION_MODEL, toVendorSession } from "./realtime";
import { parseRealtimeEvent } from "./sideband";

/**
 * Transcription sessions (#929) against OpenAI's realtime transcription guide
 * and the client_secrets reference (checked 10-11). NOTHING HERE TALKED TO A
 * LIVE VENDOR: the shapes asserted are the documented ones.
 */

type Call = { url: string; init: RequestInit };

function stubFetch(respond: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return respond(String(url));
  }) as unknown as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const secretResponse = () =>
  new Response(
    JSON.stringify({
      value: "ek_tr",
      expires_at: 1790000600,
      session: { type: "transcription", object: "realtime.transcription_session" },
    }),
    { status: 200 },
  );

describe("transcription sessions: the vendor's shape", () => {
  test("gpt-live-transcribe by default, turn detection off, no top-level model", () => {
    expect(DEFAULT_TRANSCRIPTION_MODEL).toBe("gpt-live-transcribe");
    expect(toVendorSession({ type: "transcription" }, "gpt-realtime-mini")).toEqual({
      type: "transcription",
      audio: {
        input: { transcription: { model: "gpt-live-transcribe" }, turn_detection: null },
      },
    });
  });

  test("languages, prompt, keywords, delay, noise reduction and logprobs map to the documented fields", () => {
    expect(
      toVendorSession({
        type: "transcription",
        languages: ["en", "tr"],
        prompt: "Voice commands for a website builder.",
        keywords: ["fager", "hero section"],
        delay: "low",
        noiseReduction: "near_field",
        logprobs: true,
        vendor: { extra: 1 },
      }),
    ).toEqual({
      type: "transcription",
      audio: {
        input: {
          transcription: {
            model: "gpt-live-transcribe",
            prompt: "Voice commands for a website builder.",
            keywords: ["fager", "hero section"],
            languages: ["en", "tr"],
            delay: "low",
          },
          turn_detection: null,
          noise_reduction: { type: "near_field" },
        },
      },
      include: ["item.input_audio_transcription.logprobs"],
      extra: 1,
    });
  });

  test("an older model can keep server-side turn detection and the single language", () => {
    expect(
      toVendorSession({
        type: "transcription",
        model: "gpt-4o-transcribe",
        language: "en",
        turnDetection: { type: "server_vad", silenceDurationMs: 300 },
      }),
    ).toEqual({
      type: "transcription",
      audio: {
        input: {
          transcription: { model: "gpt-4o-transcribe", language: "en" },
          turn_detection: { type: "server_vad", silence_duration_ms: 300 },
        },
      },
    });
  });

  test("refuses what the vendor rejects: both language fields, keywords with <, > or a line break", () => {
    expect(() =>
      toVendorSession({ type: "transcription", language: "en", languages: ["en"] }),
    ).toThrow(/not both/);
    for (const keyword of ["a<b", "a>b", "two\nlines", "cr\r"]) {
      expect(() => toVendorSession({ type: "transcription", keywords: [keyword] })).toThrow(
        /one line/,
      );
    }
  });
});

describe("transcription sessions: the client", () => {
  test("clientSecret mints a transcription secret with the safety identifier and says where the browser connects", async () => {
    const calls = stubFetch(secretResponse);
    const realtime = OpenAIProvider.model("gpt-realtime-mini", { apiKey: "sk-test" }).realtime;
    const secret = await realtime.clientSecret({
      ttlSeconds: 60,
      safetyIdentifier: "user-hash",
      session: { type: "transcription", languages: ["tr", "en"], delay: "minimal" },
    });

    expect(secret).toEqual({
      value: "ek_tr",
      expiresAt: 1790000600,
      session: { type: "transcription", object: "realtime.transcription_session" },
      callsUrl: "https://api.openai.com/v1/realtime/calls",
    });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization ?? headers.Authorization).toBe("Bearer sk-test");
    expect(headers["OpenAI-Safety-Identifier"]).toBe("user-hash");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              model: "gpt-live-transcribe",
              languages: ["tr", "en"],
              delay: "minimal",
            },
            turn_detection: null,
          },
        },
      },
    });
  });

  test("Azure: the same request on /openai/v1, the deployment named as the transcription model, and Azure's calls URL", async () => {
    const calls = stubFetch(secretResponse);
    const realtime = AzureOpenAIProvider.model("gpt-live-transcribe", {
      endpoint: "https://res.openai.azure.com/openai",
      apiKey: "az-key",
      deployment: "transcribe-prod",
    }).realtime;
    const secret = await realtime.clientSecret({
      session: { type: "transcription", model: "transcribe-prod" },
    });
    expect(calls[0]!.url).toBe("https://res.openai.azure.com/openai/v1/realtime/client_secrets");
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe("az-key");
    expect(JSON.parse(String(calls[0]!.init.body)).session.audio.input.transcription.model).toBe(
      "transcribe-prod",
    );
    expect(secret.callsUrl).toBe("https://res.openai.azure.com/openai/v1/realtime/calls");
  });

  test("createCall (unified) carries the transcription session, so the server holds the call and can meter it", async () => {
    const calls = stubFetch(
      () =>
        new Response("v=0 answer", {
          status: 201,
          headers: { location: "/v1/realtime/calls/rtc_tr1" },
        }),
    );
    const realtime = OpenAIProvider.model("gpt-realtime-mini", { apiKey: "sk-test" }).realtime;
    const result = await realtime.createCall({
      sdp: "v=0 offer",
      session: { type: "transcription", keywords: ["fager"] },
    });
    expect(result).toEqual({ sdpAnswer: "v=0 answer", callId: "rtc_tr1" });
    const form = calls[0]!.init.body as FormData;
    expect(JSON.parse(String(form.get("session")))).toEqual({
      type: "transcription",
      audio: {
        input: {
          transcription: { model: "gpt-live-transcribe", keywords: ["fager"] },
          turn_detection: null,
        },
      },
    });
  });

  test("the sideband maps a duration-billed transcript onto transcriptionSeconds", async () => {
    const completed = parseRealtimeEvent(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item_1",
        content_index: 0,
        transcript: "switch to mobile",
        usage: { type: "duration", seconds: 1.4 },
      }),
    );
    expect(completed).toMatchObject({ transcriptionSeconds: 1.4 });
  });
});
