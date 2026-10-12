/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useLiveTranscription } from "./useLiveTranscription";

/**
 * The hook with the browser's media, WebRTC and Web Audio faked (#929): what
 * it asks the app's route and the vendor for, what it sends on the data
 * channel, and what it shows. No vendor is involved.
 */

class FakeTrack {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeChannel {
  readyState = "connecting";
  sent: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    for (const fn of this.listeners.open ?? []) fn({});
  }
  receive(event: Record<string, unknown>) {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(event) });
  }
}

let pcs: FakePeer[] = [];
class FakePeer {
  channel = new FakeChannel();
  remote?: RTCSessionDescriptionInit;
  closed = false;
  connectionState = "new";
  tracks: unknown[] = [];
  constructor() {
    pcs.push(this);
  }
  addTrack(track: unknown) {
    this.tracks.push(track);
  }
  addEventListener() {}
  createDataChannel(label: string) {
    expect(label).toBe("oai-events");
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remote = description;
  }
  close() {
    this.closed = true;
  }
}

/** The mic's loudness, as the analyser reads it. */
let amplitude = 0;
let contexts: FakeAudioContext[] = [];
class FakeAudioContext {
  closed = false;
  constructor() {
    contexts.push(this);
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
  createAnalyser() {
    return {
      fftSize: 0,
      getFloatTimeDomainData(samples: Float32Array) {
        for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? amplitude : -amplitude;
      },
    };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
}

let track: FakeTrack;
let requests: { url: string; method: string; headers: any; body: any }[] = [];
let routeStatus = 200;
let micError: Error | null = null;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
  });
  pcs = [];
  contexts = [];
  requests = [];
  amplitude = 0;
  routeStatus = 200;
  micError = null;
  track = new FakeTrack();
  (globalThis as any).RTCPeerConnection = FakePeer;
  (globalThis as any).AudioContext = FakeAudioContext;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        if (micError) throw micError;
        return { getAudioTracks: () => [track], getTracks: () => [track] };
      }),
    },
  });
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const isJson = init.headers?.["Content-Type"] === "application/json";
    requests.push({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: isJson ? JSON.parse(init.body) : init.body,
    });
    if (String(url).startsWith("/api/")) {
      if (routeStatus !== 200) {
        return new Response(
          JSON.stringify({ error: { code: "voice_limit", message: "Daily voice limit reached." } }),
          { status: routeStatus },
        );
      }
      if (String(url) === "/api/voice/sdp") {
        return new Response(JSON.stringify({ sdp: "v=0 answer (route)" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          value: "ek_1",
          expiresAt: 1,
          callsUrl: "https://vendor.test/v1/realtime/calls",
        }),
        { status: 200 },
      );
    }
    return new Response("v=0 answer", { status: 201 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const hook = (options: any = {}, source: any = "/api/voice/token") =>
  renderHook(() => useLiveTranscription(source, options));

async function started(options: any = {}, source?: any) {
  const view = hook(options, source);
  await act(() => view.result.current.start());
  const peer = pcs[0]!;
  act(() => peer.channel.open());
  return { ...view, peer, channel: peer.channel };
}

/** Lets the meter run `ms` at the current amplitude. */
async function speak(level: number, ms: number) {
  amplitude = level;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const commits = (channel: FakeChannel) =>
  channel.sent.filter((e) => e.type === "input_audio_buffer.commit").length;

describe("useLiveTranscription", () => {
  test("gets a secret from the route, posts the offer to the vendor with it, and listens once the channel opens", async () => {
    const view = hook({ body: { pageId: "p1" }, headers: { "x-app": "1" } });
    expect(view.result.current.status).toBe("idle");
    await act(() => view.result.current.start());
    expect(view.result.current.status).toBe("connecting");

    expect(requests[0]).toMatchObject({
      url: "/api/voice/token",
      method: "POST",
      body: { pageId: "p1" },
    });
    expect(requests[0]!.headers["x-app"]).toBe("1");
    expect(requests[1]).toEqual({
      url: "https://vendor.test/v1/realtime/calls",
      method: "POST",
      headers: { Authorization: "Bearer ek_1", "Content-Type": "application/sdp" },
      body: "v=0 offer",
    });
    expect(pcs[0]!.remote).toEqual({ type: "answer", sdp: "v=0 answer" });
    expect(pcs[0]!.tracks).toEqual([track]);

    act(() => pcs[0]!.channel.open());
    expect(view.result.current.status).toBe("listening");
  });

  test("a token function, and OpenAI's calls URL when the token names none", async () => {
    const view = hook({}, async () => ({ value: "ek_fn" }));
    await act(() => view.result.current.start());
    expect(requests.map((r) => r.url)).toEqual(["https://api.openai.com/v1/realtime/calls"]);
    expect(requests[0]!.headers.Authorization).toBe("Bearer ek_fn");
  });

  test('connect: "sdp" posts the offer and body to the route and applies its answer', async () => {
    const view = hook({ connect: "sdp", body: { pageId: "p1" } }, "/api/voice/sdp");
    await act(() => view.result.current.start());
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ pageId: "p1", sdp: "v=0 offer" });
    expect(pcs[0]!.remote).toEqual({ type: "answer", sdp: "v=0 answer (route)" });
  });

  test("partials as deltas arrive, finals on completion, with the callbacks", async () => {
    const onPartial = vi.fn();
    const onFinal = vi.fn();
    const { result, channel } = await started({ onPartial, onFinal });

    act(() => {
      channel.receive({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "i1",
        delta: "make the ",
      });
      channel.receive({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "i1",
        delta: "hero bigger",
      });
    });
    expect(result.current.partial).toBe("make the hero bigger");
    expect(onPartial).toHaveBeenLastCalledWith("make the hero bigger");

    act(() =>
      channel.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "i1",
        transcript: "Make the hero bigger.",
        usage: { type: "duration", seconds: 1.5 },
      }),
    );
    expect(result.current.partial).toBe("");
    expect(result.current.turns).toEqual([
      { id: "i1", text: "Make the hero bigger.", seconds: 1.5 },
    ]);
    expect(onFinal).toHaveBeenCalledWith({ id: "i1", text: "Make the hero bigger.", seconds: 1.5 });
    expect(onPartial).toHaveBeenLastCalledWith("");
  });

  test("the built-in detector commits when the user stops for silenceMs, and shows speaking and the level", async () => {
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const { result, channel } = await started({ silenceMs: 300, onSpeechStart, onSpeechEnd });

    await speak(0.001, 600);
    expect(commits(channel)).toBe(0);
    await speak(0.12, 400);
    expect(result.current.speaking).toBe(true);
    expect(result.current.level).toBeGreaterThan(0.5);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);

    await speak(0.001, 200);
    expect(commits(channel)).toBe(0); // a pause, not the end yet
    await speak(0.001, 200);
    expect(commits(channel)).toBe(1);
    expect(result.current.speaking).toBe(false);
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);

    // silence after a commit commits nothing more
    await speak(0.001, 2000);
    expect(commits(channel)).toBe(1);
  });

  test("a plugged-in detector gets the stream; its speechEnd commits, and the energy detector is off", async () => {
    let events: { speechStart(): void; speechEnd(): void } | undefined;
    const stop = vi.fn();
    const vad = vi.fn((_stream: MediaStream, e: typeof events) => {
      events = e;
      return { stop };
    });
    const { result, channel, unmount } = await started({ vad });
    expect(vad).toHaveBeenCalledTimes(1);

    await speak(0.2, 2000);
    await speak(0.001, 2000);
    expect(commits(channel)).toBe(0);

    act(() => events!.speechStart());
    expect(result.current.speaking).toBe(true);
    act(() => events!.speechEnd());
    expect(commits(channel)).toBe(1);
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  test("commit() ends the turn by hand", async () => {
    const { result, channel } = await started({ vad: false });
    act(() => result.current.commit());
    expect(channel.sent).toEqual([{ type: "input_audio_buffer.commit" }]);
  });

  test("stop() releases the microphone, the peer connection and the audio context", async () => {
    const { result, peer } = await started();
    await act(() => result.current.stop());
    expect(result.current.status).toBe("idle");
    expect(track.stopped).toBe(true);
    expect(peer.closed).toBe(true);
    expect(contexts[0]!.closed).toBe(true);
  });

  test("stop({ flush }) commits speech in progress and waits for its final", async () => {
    const onFinal = vi.fn();
    const { result, channel, peer } = await started({ onFinal });
    await speak(0.12, 400);
    expect(result.current.speaking).toBe(true);

    let done = false;
    let stopping!: Promise<void>;
    act(() => {
      stopping = result.current.stop({ flush: true }).then(() => {
        done = true;
      });
    });
    expect(commits(channel)).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(done).toBe(false);
    expect(peer.closed).toBe(false);

    await act(async () => {
      channel.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "i9",
        transcript: "Publish it.",
      });
      await stopping;
    });
    expect(done).toBe(true);
    expect(onFinal).toHaveBeenCalledWith({ id: "i9", text: "Publish it." });
    expect(peer.closed).toBe(true);
  });

  test("unmounting tears everything down", async () => {
    const { unmount, peer } = await started();
    unmount();
    expect(track.stopped).toBe(true);
    expect(peer.closed).toBe(true);
  });

  test("a denied microphone is microphone_denied, and nothing is left open", async () => {
    micError = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const onError = vi.fn();
    const view = hook({ onError });
    await act(() => view.result.current.start());
    expect(view.result.current.status).toBe("idle");
    expect(view.result.current.error?.code).toBe("microphone_denied");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(pcs).toHaveLength(0);
  });

  test("a refused token route surfaces its code and status, and releases the microphone", async () => {
    routeStatus = 429;
    const view = hook();
    await act(() => view.result.current.start());
    expect(view.result.current.error).toMatchObject({
      code: "voice_limit",
      status: 429,
      message: "Daily voice limit reached.",
    });
    expect(track.stopped).toBe(true);
    expect(pcs[0]!.closed).toBe(true);
    expect(view.result.current.status).toBe("idle");
  });

  test("an unsupported browser says so", async () => {
    (globalThis as any).RTCPeerConnection = undefined;
    const view = hook();
    await act(() => view.result.current.start());
    expect(view.result.current.error?.code).toBe("unsupported");
  });

  test("a second start while live does nothing; vendor errors are shown without closing", async () => {
    const { result, channel } = await started();
    await act(() => result.current.start());
    expect(pcs).toHaveLength(1);
    act(() =>
      channel.receive({
        type: "error",
        error: { code: "invalid_value", message: "Bad language." },
      }),
    );
    expect(result.current.error?.code).toBe("invalid_value");
    expect(result.current.status).toBe("listening");
  });
});
