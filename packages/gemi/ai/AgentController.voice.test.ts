process.env.SECRET ??= "agent-controller-voice-test-secret";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { InsufficientPermissionsError } from "../http/errors";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { ApiRouter } from "../http/ApiRouter";
import { createFlatApiRoutes } from "../services/router/createFlatApiRoutes";
import { Agent } from "./Agent";
import {
  AgentController,
  type AuthorizeRequestParams,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { FakeSocket, fakeSocketFactory } from "./providers/__fixtures__/fakeSocket";
import { openAITarget } from "./providers/endpoints";
import { fakeProvider } from "./providers/fakeProvider";
import { RealtimeClient } from "./providers/realtime";
import type { VoiceSummary } from "./VoiceBridge";
import type { VoiceConfig } from "./voiceConfig";
import { MemoryVoiceSessionStore } from "./voiceStore";

/**
 * `this.voice(Controller)` end to end (#921), with a real controller and agent
 * (a scripted provider) and the vendor faked at the HTTP and WebSocket layer,
 * following the documented protocol. Nothing here reaches a live vendor.
 */

const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";
const ANSWER = "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\n";

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

type PageBody = { pageId: string };

const realFetch = globalThis.fetch;
let fetches: { url: string; method?: string; body?: any }[] = [];
let createStatus = 201;

beforeEach(() => {
  FakeSocket.all = [];
  fetches = [];
  createStatus = 201;
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetches.push({ url: String(url), method: init?.method, body: init?.body });
    if (String(url).endsWith("/realtime/calls")) {
      return createStatus === 201
        ? new Response(ANSWER, { status: 201, headers: { location: "/v1/realtime/calls/rtc_42" } })
        : new Response(JSON.stringify({ error: { message: "down" } }), { status: createStatus });
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function setup(options: { voice?: boolean } = {}) {
  const store = new MemoryAgentStore();
  const liveRuns = new MemoryLiveRuns();
  const voiceStore = new MemoryVoiceSessionStore();
  const provider = fakeProvider([{ type: "text-delta", delta: "Darker now." }, finish()]);
  const realtime = new RealtimeClient(openAITarget({ apiKey: "sk-test" }), {
    model: "gpt-realtime-mini",
    webSocket: fakeSocketFactory,
  });
  const seen = {
    authorize: [] as AuthorizeRequestParams<PageBody>[],
    starts: [] as any[],
    ends: [] as VoiceSummary[],
    instructions: [] as PageBody[],
  };

  const voice: VoiceConfig<PageBody> = {
    realtime,
    start: (context) => {
      seen.starts.push({ body: context.body, threadId: context.threadId, user: context.user });
      if ((context.body as any).broke) throw new InsufficientPermissionsError();
      return {
        ...((context.body as any).otherThread
          ? { threadId: (context.body as any).otherThread }
          : {}),
        session: { instructions: "Be the page builder's voice.", voice: "marin" },
        contextNote: (body) => `The user is on page ${body.pageId}.`,
        onEnd: (summary) => void seen.ends.push(summary),
      };
    },
  };

  class PageChat extends AgentController<any, PageBody> {
    agent = Agent.create({ name: "page-chat", provider }) as any;
    store = store;
    liveRuns = liveRuns;
    voiceStore = voiceStore;
    voice = options.voice === false ? undefined : voice;

    protected authorizeRequest(
      _req: HttpRequest<any, any>,
      params: AuthorizeRequestParams<PageBody>,
    ) {
      seen.authorize.push(params);
      if (params.threadId === "forbidden") throw new InsufficientPermissionsError();
    }

    instructions(_req: HttpRequest<any, any>, { body }: { body: PageBody }) {
      seen.instructions.push(body);
      return `You edit page ${body.pageId}.`;
    }
  }

  const call = async (
    method: "voiceStart" | "voiceUpdate" | "voiceEnd",
    payload: unknown,
    params: Record<string, string> = {},
    user: unknown = { id: 1 },
  ) => {
    const httpMethod = { voiceStart: "POST", voiceUpdate: "PATCH", voiceEnd: "DELETE" }[method];
    const req = new HttpRequest<any, any>(
      new Request("http://localhost/api/chat/voice", {
        method: httpMethod,
        headers: { "Content-Type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
      params,
    );
    return RequestContext.run(req, () => new PageChat()[method](req), { user } as any);
  };

  return { store, voiceStore, seen, call, PageChat, provider };
}

describe("AgentController voice routes", () => {
  test("POST starts a call with the server key and the bridge's tools, and a delegated request runs as a turn", async () => {
    const { store, voiceStore, seen, call, provider } = setup();
    const { threadId } = await store.createThread({ userId: 1 });

    const started = (await call("voiceStart", { sdp: OFFER, threadId, pageId: "p_1" })) as any;
    expect(started).toEqual({
      sessionId: expect.any(String),
      sdp: ANSWER,
      threadId,
      delegate: "ask_agent",
      endsAt: expect.any(Number),
    });
    expect(seen.authorize).toEqual([{ route: "stream", threadId, body: { pageId: "p_1" } }]);
    expect(seen.starts).toEqual([{ body: { pageId: "p_1" }, threadId, user: { id: 1 } }]);

    const create = fetches.find((f) => f.url === "https://api.openai.com/v1/realtime/calls")!;
    const session = JSON.parse(String((create.body as FormData).get("session")));
    expect(session.model).toBe("gpt-realtime-mini");
    expect(session.instructions).toBe("Be the page builder's voice.");
    expect(session.tools.map((t: { name: string }) => t.name)).toEqual([
      "ask_agent",
      "stop_work",
      "work_status",
      "answer_question",
    ]);
    expect(await voiceStore.get(started.sessionId)).toMatchObject({
      callId: "rtc_42",
      threadId,
      owner: "user:1",
      body: { pageId: "p_1" },
    });

    await flush();
    const socket = FakeSocket.last();
    expect(socket.url).toBe("wss://api.openai.com/v1/realtime?call_id=rtc_42");
    socket.serverOpen();
    socket.serverSend({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      item_id: "i1",
      call_id: "call_1",
      name: "ask_agent",
      arguments: JSON.stringify({ request: "Make the hero darker." }),
    });
    await vi.waitFor(() =>
      expect(socket.sent.some((e) => e.item?.type === "function_call_output")).toBe(true),
    );
    const output = socket.sent.find((e) => e.item?.type === "function_call_output");
    expect(output.item.call_id).toBe("call_1");
    expect(JSON.parse(output.item.output)).toEqual({ status: "done", text: "Darker now." });
    // The turn went through the controller with the session's body, and is on the thread.
    expect(seen.instructions).toEqual([{ pageId: "p_1" }]);
    expect(provider.calls).toHaveLength(1);
    const stored = (await store.loadThread(threadId))!;
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);

    await call("voiceEnd", undefined, { sessionId: started.sessionId });
  });

  test("PATCH updates the body for the next turn and tells the voice; DELETE hangs up and runs onEnd", async () => {
    const { store, voiceStore, seen, call } = setup();
    const { threadId } = await store.createThread({ userId: 1 });
    const started = (await call("voiceStart", { sdp: OFFER, threadId, pageId: "p_1" })) as any;
    await flush();
    const socket = FakeSocket.last();
    socket.serverOpen();

    expect(await call("voiceUpdate", { pageId: "p_2" }, { sessionId: started.sessionId })).toEqual({
      updated: true,
    });
    expect((await voiceStore.get(started.sessionId))!.body).toEqual({ pageId: "p_2" });
    await flush();
    expect(socket.sent.at(-1).item.content[0].text).toBe("The user is on page p_2.");
    expect(seen.authorize.at(-1)).toEqual({ route: "stream", threadId, body: { pageId: "p_2" } });

    expect(await call("voiceEnd", undefined, { sessionId: started.sessionId })).toEqual({
      ended: true,
    });
    expect(fetches.at(-1)).toMatchObject({
      url: "https://api.openai.com/v1/realtime/calls/rtc_42/hangup",
      method: "POST",
    });
    expect(seen.ends.map((s) => s.reason)).toEqual(["hangup"]);
    expect((await voiceStore.get(started.sessionId))!.endReason).toBe("hangup");

    // Ended: a second end is a no-op and an update is refused.
    expect(await call("voiceEnd", undefined, { sessionId: started.sessionId })).toEqual({
      ended: false,
    });
    const refused = (await call(
      "voiceUpdate",
      { pageId: "p_3" },
      { sessionId: started.sessionId },
    )) as Response;
    expect(refused.status).toBe(409);
  });

  test("another user's session is refused, and an unknown one is a 404", async () => {
    const { store, call } = setup();
    const { threadId } = await store.createThread({ userId: 1 });
    const started = (await call("voiceStart", { sdp: OFFER, threadId, pageId: "p_1" })) as any;

    const other = (await call(
      "voiceEnd",
      undefined,
      { sessionId: started.sessionId },
      { id: 2 },
    )) as Response;
    expect(other.status).toBe(403);
    const missing = (await call("voiceEnd", undefined, { sessionId: "nope" })) as Response;
    expect(missing.status).toBe(404);
    await call("voiceEnd", undefined, { sessionId: started.sessionId });
  });

  test("a DELETE on an instance that does not hold the bridge hangs up at the vendor", async () => {
    const { voiceStore, call } = setup();
    await voiceStore.create({
      id: "elsewhere",
      callId: "rtc_other",
      threadId: "t",
      owner: "user:1",
      body: { pageId: "p" },
      startedAt: 0,
    });
    expect(await call("voiceEnd", undefined, { sessionId: "elsewhere" })).toEqual({ ended: true });
    expect(fetches.at(-1)!.url).toBe("https://api.openai.com/v1/realtime/calls/rtc_other/hangup");
    expect((await voiceStore.get("elsewhere"))!.endReason).toBe("hangup");
  });

  test("push-to-talk starts with turn detection off", async () => {
    const { store, call } = setup();
    const { threadId } = await store.createThread({ userId: 1 });
    const started = (await call("voiceStart", {
      sdp: OFFER,
      threadId,
      pageId: "p",
      pushToTalk: true,
    })) as any;
    const session = JSON.parse(String((fetches[0]!.body as FormData).get("session")));
    expect(session.audio.input.turn_detection).toBeNull();
    await call("voiceEnd", undefined, { sessionId: started.sessionId });
  });

  test("refusals: no voice config, no sdp, no thread, a refusing start, a vendor failure", async () => {
    const noVoice = setup({ voice: false });
    expect(
      ((await noVoice.call("voiceStart", { sdp: OFFER, threadId: "t" })) as Response).status,
    ).toBe(404);

    const { store, seen, call } = setup();
    const { threadId } = await store.createThread({ userId: 1 });
    expect(((await call("voiceStart", { threadId })) as Response).status).toBe(400);
    expect(((await call("voiceStart", { sdp: OFFER, pageId: "p" })) as Response).status).toBe(400);
    await expect(call("voiceStart", { sdp: OFFER, threadId, broke: true })).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );

    createStatus = 500;
    const failed = (await call("voiceStart", { sdp: OFFER, threadId, pageId: "p" })) as Response;
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.code).toBe("voice_unavailable");
    // the thread-less start and the vendor failure both ran `start`, so both refund
    expect(seen.ends.map((s) => s.reason)).toEqual(["start_failed", "start_failed"]);
  });

  test("push-to-talk toggled mid-call: the vendor's session.updated echo does not end the call", async () => {
    const { store, voiceStore, seen, call } = setup();
    const { threadId } = await store.createThread({ userId: 1 });
    const started = (await call("voiceStart", { sdp: OFFER, threadId, pageId: "p" })) as any;
    const session = JSON.parse(String((fetches[0]!.body as FormData).get("session")));
    await flush();
    const socket = FakeSocket.last();
    socket.serverOpen();
    // the hook's setPushToTalk(true) sends session.update; the vendor echoes the whole session
    socket.serverSend({
      type: "session.updated",
      session: { ...session, audio: { input: { turn_detection: null } } },
    });
    await flush();
    expect(seen.ends).toEqual([]);
    expect((await voiceStore.get(started.sessionId))!.endedAt).toBeUndefined();
    await call("voiceEnd", undefined, { sessionId: started.sessionId });
    expect(seen.ends.map((s) => s.reason)).toEqual(["hangup"]);
  });

  test("a failure after start ran calls onEnd(start_failed); one after the vendor call exists also hangs it up", async () => {
    const { store, voiceStore, seen, call } = setup();
    const { threadId } = await store.createThread({ userId: 1 });

    // the thread `start` answered is refused
    await expect(
      call("voiceStart", { sdp: OFFER, threadId, pageId: "p", otherThread: "forbidden" }),
    ).rejects.toBeInstanceOf(InsufficientPermissionsError);
    expect(seen.ends.map((s) => s.reason)).toEqual(["start_failed"]);
    expect(fetches).toEqual([]);

    // the store fails after the vendor created the call
    voiceStore.create = async () => {
      throw new Error("database down");
    };
    const failed = (await call("voiceStart", { sdp: OFFER, threadId, pageId: "p" })) as Response;
    expect(failed.status).toBe(500);
    expect(fetches.map((f) => f.url)).toEqual([
      "https://api.openai.com/v1/realtime/calls",
      "https://api.openai.com/v1/realtime/calls/rtc_42/hangup",
    ]);
    expect(seen.ends.map((s) => [s.reason, s.callId])).toEqual([
      ["start_failed", undefined],
      ["start_failed", "rtc_42"],
    ]);
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe("ApiRouter.voice()", () => {
  test("mounts POST, PATCH and DELETE under one path", () => {
    const { PageChat } = setup();
    class Api extends ApiRouter {
      routes = { "/chat/voice": this.voice(PageChat) };
    }
    const flat = createFlatApiRoutes(new Api().routes);
    expect(Object.keys(flat).sort()).toEqual(["/chat/voice", "/chat/voice/:sessionId"]);
    expect(Object.keys(flat["/chat/voice"]!).sort()).toEqual(["OPTIONS", "POST"]);
    expect(Object.keys(flat["/chat/voice/:sessionId"]!).sort()).toEqual([
      "DELETE",
      "OPTIONS",
      "PATCH",
    ]);
  });

  test("refuses a class that is not an AgentController", () => {
    class NotAnAgent {}
    expect(
      () =>
        new (class extends ApiRouter {
          routes = { "/v": this.voice(NotAnAgent) };
        })(),
    ).toThrow("this.voice() takes an AgentController class, and got NotAnAgent.");
  });
});
