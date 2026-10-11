/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useVoiceSession } from "./useVoiceSession";

/**
 * The hook with the browser's media and WebRTC faked: what it posts to the
 * app's route, what it sends on the data channel, and what it shows. The
 * vendor end is not involved; the route answers for it.
 */

class FakeTrack {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeChannel {
  readyState = "open";
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
  receive(event: Record<string, unknown>) {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(event) });
  }
}

let track: FakeTrack;
let pcs: FakePeer[] = [];

class FakePeer {
  channel = new FakeChannel();
  remote?: RTCSessionDescriptionInit;
  closed = false;
  connectionState = "new";
  ontrack: ((e: any) => void) | null = null;
  constructor() {
    pcs.push(this);
  }
  addTrack() {}
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

let requests: { url: string; method: string; body?: any; keepalive?: boolean }[] = [];
let startStatus = 200;

beforeEach(() => {
  pcs = [];
  requests = [];
  startStatus = 200;
  track = new FakeTrack();
  (globalThis as any).RTCPeerConnection = FakePeer;
  (globalThis as any).MediaStream = class {
    constructor(readonly tracks: unknown[] = []) {}
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      })),
    },
  });
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    requests.push({
      url: String(url),
      method: init.method,
      body: init.body && JSON.parse(init.body),
      keepalive: init.keepalive,
    });
    if (init.method === "POST") {
      return startStatus === 200
        ? new Response(
            JSON.stringify({
              sessionId: "s1",
              sdp: "v=0 answer",
              threadId: "t1",
              delegate: "ask_builder",
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({ error: { code: "out_of_credits", message: "No credits." } }),
            {
              status: startStatus,
            },
          );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

const hook = (params: any = {}) =>
  renderHook(() =>
    useVoiceSession("/chat/voice" as never, { threadId: "t1", body: { pageId: "p1" }, ...params }),
  );

describe("useVoiceSession", () => {
  test("start posts the offer, thread and body, and applies the answer", async () => {
    const { result } = hook();
    expect(result.current.status).toBe("idle");
    await act(() => result.current.start());

    expect(requests[0]).toEqual({
      url: "/api/chat/voice",
      method: "POST",
      body: { pageId: "p1", sdp: "v=0 offer", threadId: "t1" },
    });
    expect(pcs[0]!.remote).toEqual({ type: "answer", sdp: "v=0 answer" });
    expect(result.current.status).toBe("listening");
    expect(result.current.sessionId).toBe("s1");
  });

  test("shows what the data channel says: speaking, working, captions", async () => {
    const { result } = hook();
    await act(() => result.current.start());
    const channel = pcs[0]!.channel;

    act(() => channel.receive({ type: "output_audio_buffer.started" }));
    expect(result.current.status).toBe("speaking");
    act(() => {
      channel.receive({ type: "output_audio_buffer.stopped" });
      // the delegate name the route answered, not the default
      channel.receive({
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "ask_builder",
      });
      channel.receive({
        type: "response.output_audio_transcript.done",
        item_id: "a1",
        transcript: "On it.",
      });
    });
    expect(result.current.status).toBe("working");
    expect(result.current.captions).toEqual([
      { id: "a1", role: "assistant", text: "On it.", final: true },
    ]);
  });

  test("mute, push-to-talk, setBody and end", async () => {
    const { result } = hook();
    await act(() => result.current.start());
    const channel = pcs[0]!.channel;

    act(() => result.current.mute());
    expect(result.current.muted).toBe(true);
    expect(track.enabled).toBe(false);
    act(() => result.current.mute(false));
    expect(track.enabled).toBe(true);

    act(() => result.current.setPushToTalk(true));
    expect(track.enabled).toBe(false);
    expect(channel.sent.at(-1)).toEqual({
      type: "session.update",
      session: { type: "realtime", audio: { input: { turn_detection: null } } },
    });
    act(() => result.current.press());
    expect(track.enabled).toBe(true);
    act(() => result.current.release());
    expect(track.enabled).toBe(false);
    expect(channel.sent.slice(-2)).toEqual([
      { type: "input_audio_buffer.commit" },
      { type: "response.create" },
    ]);

    await act(() => result.current.setBody({ pageId: "p2" } as never));
    expect(requests.at(-1)).toEqual({
      url: "/api/chat/voice/s1",
      method: "PATCH",
      body: { pageId: "p2" },
    });

    await act(() => result.current.end());
    expect(requests.at(-1)).toMatchObject({
      url: "/api/chat/voice/s1",
      method: "DELETE",
      keepalive: true,
    });
    expect(pcs[0]!.closed).toBe(true);
    expect(track.stopped).toBe(true);
    expect(result.current.status).toBe("ended");
  });

  test("a refused start reports the route's error and releases the microphone", async () => {
    startStatus = 402;
    const onError = vi.fn();
    const { result } = hook({ onError });
    await act(() => result.current.start());
    expect(result.current.status).toBe("ended");
    expect(result.current.error).toMatchObject({
      code: "out_of_credits",
      status: 402,
      message: "No credits.",
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(track.stopped).toBe(true);
  });

  test("a denied microphone is microphone_denied, and nothing is posted", async () => {
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValueOnce(
      new Error("NotAllowedError"),
    );
    const { result } = hook();
    await act(() => result.current.start());
    expect(result.current.error).toMatchObject({ code: "microphone_denied" });
    expect(requests).toEqual([]);
  });

  test("a second start() while the first is in flight starts nothing", async () => {
    const { result } = hook();
    await act(() => Promise.all([result.current.start(), result.current.start()]));
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(pcs).toHaveLength(1);
  });

  test("unmounting ends the call", async () => {
    const { result, unmount } = hook();
    await act(() => result.current.start());
    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(requests.at(-1)).toMatchObject({ method: "DELETE" });
  });
});
