process.env.SECRET ??= "agent-controller-busy-test-secret";

import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { Agent, AgentTool } from "./Agent";
import {
  AgentController,
  type AgentStore,
  type AgentTurn,
  type AgentTurnBusyPolicy,
  AgentTurnError,
  type BusyPolicyParams,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { decodeSSE } from "./client/sse";
import { turnStarts } from "./contextWindow";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import { DatabaseAgentStore } from "./store/DatabaseAgentStore";
import type { AgentMessage, AgentStreamFrame } from "./types";

/**
 * A message sent while a reply is still coming: joined to the running turn
 * (`ifBusy: "join"`), or answered by a second run beside it
 * (`ifBusy: "parallel"`), as the controller's `busyPolicy` decides.
 */

const finish = (reason: "stop" | "tool-calls" = "stop"): ProviderEvent => ({
  type: "finish",
  reason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const say = (text: string): ProviderEvent[] => [{ type: "text-delta", delta: text }, finish()];

const textOf = (message: AgentMessage) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Every store the ordering has to hold in: memory, and the database store on SQLite. */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const stores: { name: string; make(): Promise<AgentStore> }[] = [
  { name: "memory", make: async () => new MemoryAgentStore() },
  {
    name: "database (sqlite)",
    async make() {
      const dir = mkdtempSync(join(tmpdir(), "gemi-agent-busy-"));
      const sql = new SQL(`sqlite://${join(dir, "threads.db")}`);
      const store = new DatabaseAgentStore({ sql, dialect: "sqlite" });
      await store.createTable();
      cleanups.push(async () => {
        await sql.close();
        rmSync(dir, { recursive: true, force: true });
      });
      return store;
    },
  },
];

type Body = { pageId?: string };

/**
 * A controller whose model calls each wait for a gate of their own:
 * `release(n)` lets the n-th call answer.
 */
async function setup(
  scripts: ProviderEvent[][],
  options: {
    store?: AgentStore;
    maxSteps?: number;
    busyPolicy?: (params: BusyPolicyParams<Body>) => AgentTurnBusyPolicy;
    maxThreadRuns?: number;
    maxConcurrentRuns?: number;
    tools?: any[];
  } = {},
) {
  const store = options.store ?? new MemoryAgentStore();
  const liveRuns = new MemoryLiveRuns();
  const provider = fakeProvider(...scripts);
  const gates: { promise: Promise<void>; open: () => void }[] = [];
  const gateFor = (index: number) => {
    while (gates.length <= index) {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      gates.push({ promise, open });
    }
    return gates[index]!;
  };
  let calls = 0;
  // What each call was sent, as it is asked (the provider records it only
  // once its gate opens).
  const sent: AgentMessage[][] = [];
  provider.stream = (params) => {
    const index = calls++;
    sent[index] = params.messages as AgentMessage[];
    provider.calls.push(params);
    return (async function* () {
      await gateFor(index).promise;
      // The call's own script, whichever order the gates open in.
      yield* scripts[index] ?? [finish()];
    })();
  };
  const asked: BusyPolicyParams<Body>[] = [];

  class Chat extends AgentController<any, Body> {
    agent = Agent.create({
      name: "busy-chat",
      provider,
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
    }) as any;
    store = store;
    liveRuns = liveRuns;
    protected maxConcurrentRuns = options.maxConcurrentRuns ?? 5;

    protected busyPolicy(req: HttpRequest<any, any>, params: BusyPolicyParams<Body>) {
      asked.push(params);
      return options.busyPolicy ? options.busyPolicy(params) : super.busyPolicy(req, params);
    }

    protected maxThreadRuns(req: HttpRequest<any, any>, params: any) {
      return options.maxThreadRuns ?? super.maxThreadRuns(req, params);
    }
  }

  return {
    store,
    liveRuns,
    provider,
    Chat,
    asked,
    sent,
    release: (index: number) => gateFor(index).open(),
    calls: () => calls,
  };
}

function request(path: string, body: unknown) {
  const raw = new Request(`http://localhost/api/chat${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", `/chat${path}`);
}

async function framesOf(response: Response): Promise<AgentStreamFrame[]> {
  const frames: AgentStreamFrame[] = [];
  for await (const frame of decodeSSE(response.body)) frames.push(frame as AgentStreamFrame);
  return frames;
}

/** Waits until `check` holds, a tick at a time. */
async function until(check: () => boolean | Promise<boolean>, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await tick();
  }
  throw new Error("timed out waiting");
}

describe.each(stores)("join ($name)", ({ make }) => {
  test("the running run reads the joined message at its next step, and stores it in order", async () => {
    const { store, provider, Chat, release, calls, liveRuns } = await setup(
      [say("first"), say("second")],
      { store: await make() },
    );
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });

    const joined = (await Chat.startTurn({ threadId, text: "and make it blue", ifBusy: "join" })) as AgentTurn;
    expect(joined.joined).toBe(true);
    expect(joined.runId).toBe(first.runId);
    expect(first.joined).toBe(false);

    // The model was about to finish: the run makes one more call for the message.
    release(0);
    await until(() => calls() === 2);
    release(1);
    const result = await first.result();
    expect(result.finishReason).toBe("stop");
    expect((await joined.result()).text).toBe("second");

    expect(provider.calls[1]!.messages.map((message) => textOf(message as AgentMessage))).toEqual([
      "hi",
      "first",
      "and make it blue",
    ]);
    // One run answered both.
    expect(liveRuns.size).toBe(1);

    const stored = (await store.loadThread(threadId))!;
    expect(stored.map(textOf)).toEqual(["hi", "first", "and make it blue", "second"]);
    expect(stored[2]).toMatchObject({ role: "user", joined: true });
    expect(stored[0]!.joined).toBeUndefined();
    // The joined message is not a turn start: the four messages are one turn.
    expect(turnStarts(stored)).toEqual([0]);
  });

  test("a message joined while a tool runs is read after the tool's result", async () => {
    let finishTool!: () => void;
    const toolDone = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    let toolStarted = false;
    const slow = AgentTool.create({
      name: "paint",
      description: "Paints the page",
      inputSchema: s.object({ color: s.string() }),
      execute: async ({ color }) => {
        toolStarted = true;
        await toolDone;
        return { painted: color };
      },
    });
    const { store, provider, Chat, release } = await setup(
      [
        [
          { type: "tool-call", toolCallId: "call_1", name: "paint", args: '{"color":"red"}' },
          finish("tool-calls"),
        ],
        say("painted red, and noted"),
      ],
      { store: await make(), tools: [slow] },
    );
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "paint it red" });
    release(0);
    await until(() => toolStarted);

    await Chat.startTurn({ threadId, text: "then add a border", ifBusy: "join" });
    finishTool();
    release(1);
    expect((await first.result()).finishReason).toBe("stop");

    const second = provider.calls[1]!.messages as AgentMessage[];
    expect(second.at(-1)).toMatchObject({ role: "user", joined: true });
    expect(textOf(second.at(-1)!)).toBe("then add a border");

    const stored = (await store.loadThread(threadId))!;
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(stored[1]!.content.some((part) => part.type === "tool-result")).toBe(true);
    expect(textOf(stored[2]!)).toBe("then add a border");
  });
});

describe("join: the race with a run that is ending", () => {
  test("a run on its last step does not take the message: it starts a turn of its own after", async () => {
    const { store, provider, Chat, release, calls } = await setup([say("first"), say("second")], {
      maxSteps: 1,
    });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    await until(() => calls() === 1);

    const late = Chat.startTurn({ threadId, text: "one more thing", ifBusy: "join" });
    await tick();
    release(0);
    expect((await first.result()).text).toBe("first");
    const turn = (await late) as AgentTurn;
    expect(turn.joined).toBe(false);
    expect(turn.runId).not.toBe(first.runId);
    release(1);
    expect((await turn.result()).text).toBe("second");

    expect(provider.calls[1]!.messages.map((message) => textOf(message as AgentMessage))).toEqual([
      "hi",
      "first",
      "one more thing",
    ]);
    const stored = (await store.loadThread(threadId))!;
    expect(stored.map(textOf)).toEqual(["hi", "first", "one more thing", "second"]);
    // It started a turn, so it is a turn start and not a joined message.
    expect(stored[2]!.joined).toBeUndefined();
    expect(turnStarts(stored)).toEqual([0, 2]);
  });

  test("a message accepted by a run that then stops is answered by a turn started for it", async () => {
    const { store, provider, Chat, release, calls } = await setup([say("first"), say("second")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    await until(() => calls() === 1);

    const joined = (await Chat.startTurn({ threadId, text: "also this", ifBusy: "join" })) as AgentTurn;
    expect(joined.joined).toBe(true);
    // The run ends before it reached the step that would read the message.
    first.stop();
    release(0);
    expect((await first.result()).finishReason).toBe("aborted");

    await until(() => calls() === 2);
    release(1);
    const result = await joined.result();
    expect(result.text).toBe("second");
    expect(result.runId).not.toBe(first.runId);

    const last = provider.calls[1]!.messages.at(-1) as AgentMessage;
    expect(textOf(last)).toBe("also this");
    const stored = (await store.loadThread(threadId))!;
    // The stopped answer had nothing yet: it is kept, cut off, before the message.
    expect(stored.map(textOf)).toEqual(["hi", "", "also this", "second"]);
    expect(stored[1]!.finishReason).toBe("aborted");
    expect(stored[2]!.joined).toBeUndefined();
  });

  test("AgentRun.join answers null once the run has ended, and for a message with nothing in it", async () => {
    const provider = fakeProvider(say("done"));
    const agent = Agent.create({ name: "joiner", provider });
    const run = agent.stream({ messages: [], turn: { text: "hi" } });
    expect(run.join!({})).toBeNull();
    await run.result();
    expect(run.join!({ text: "late" })).toBeNull();
  });

  test("a client turn that finds its run ending gets the next run's stream on the same response", async () => {
    const { store, Chat, release, calls } = await setup([say("first"), say("second")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    await until(() => calls() === 1);

    const response = await new Chat().stream(
      request("", { threadId, turn: { text: "also this", localId: "local_1" }, ifBusy: "join" }),
    );
    expect(response.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    const reading = framesOf(response);
    first.stop();
    release(0);
    await until(() => calls() === 2);
    release(1);
    const frames = await reading;
    const starts = frames.filter((frame) => frame.event.type === "run-start");
    // The joined run, then the turn started for the message it did not take.
    expect(starts).toHaveLength(2);
    expect((starts[0]!.event as { runId: string }).runId).toBe(first.runId);
    const renamed = frames.find((frame) => frame.event.type === "message-id");
    expect(renamed?.event).toMatchObject({ localId: "local_1" });
  });
});

describe("join from a client turn", () => {
  test("answers with the running run's stream, which renames the client's copy when the run takes it", async () => {
    const { store, Chat, release, calls } = await setup([say("first"), say("second")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });

    const response = await new Chat().stream(
      request("", { threadId, turn: { text: "and blue", localId: "local_7" }, ifBusy: "join" }),
    );
    expect(response.status).toBe(200);
    const reading = framesOf(response);
    release(0);
    await until(() => calls() === 2);
    release(1);
    const frames = await reading;
    // From the run's first frame, so a client that was not following it gets the whole reply.
    expect(frames[0]!.event).toEqual({ type: "run-start", runId: first.runId, threadId });
    const renamed = frames.find((frame) => frame.event.type === "message-id")!.event as any;
    expect(renamed.localId).toBe("local_7");
    expect(renamed.message).toMatchObject({ role: "user", joined: true });
    expect(frames.filter((frame) => frame.event.type === "run-start")).toHaveLength(1);
    expect(frames.at(-1)!.event).toMatchObject({ type: "run-end", finishReason: "stop" });
    await first.result();
  });

  test("refuses an ifBusy a client may not send", async () => {
    const { store, Chat } = await setup([say("x")]);
    const { threadId } = await store.createThread({});
    for (const ifBusy of ["skip", "later", 3]) {
      const response = await new Chat().stream(request("", { threadId, turn: { text: "hi" }, ifBusy }));
      expect(response.status).toBe(400);
    }
  });

  test("another caller's run is not joined", async () => {
    const { store, Chat, release } = await setup([say("first"), say("second")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi", user: { id: 1 } });
    await expect(
      Chat.startTurn({ threadId, text: "mine now", user: { id: 2 }, ifBusy: "join" }),
    ).rejects.toMatchObject({ status: 403 });
    release(0);
    await first.result();
  });
});

describe.each(stores)("parallel ($name)", ({ make }) => {
  test("a second run starts at once beside the first; each reads the thread as it started, and both are stored", async () => {
    const { store, sent, Chat, release, calls, liveRuns } = await setup(
      [say("first answer"), say("second answer")],
      { store: await make() },
    );
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "write the hero" });
    await until(() => calls() === 1);

    const second = (await Chat.startTurn({
      threadId,
      text: "what time is it",
      ifBusy: "parallel",
    })) as AgentTurn;
    expect(second.runId).not.toBe(first.runId);
    expect(second.joined).toBe(false);
    // Started without waiting for the first run.
    await until(() => calls() === 2);
    expect(liveRuns.running({ threadId }).map((info) => info.runId)).toEqual([
      first.runId,
      second.runId,
    ]);

    // Without what the first run is still writing, plus its own.
    expect(sent[1]!.map(textOf)).toEqual(["write the hero", "what time is it"]);
    expect(sent[0]!.map(textOf)).toEqual(["write the hero"]);

    // Each finishes on its own, the second first.
    release(1);
    expect((await second.result()).text).toBe("second answer");
    release(0);
    expect((await first.result()).text).toBe("first answer");

    const stored = (await store.loadThread(threadId))!;
    expect(stored).toHaveLength(4);
    expect(stored.every((message) => message.finishReason !== undefined)).toBe(true);
    const texts = stored.map(textOf);
    expect(texts).toContain("first answer");
    expect(texts).toContain("second answer");
    // Arrival order: each run's messages after its own question, none lost or overwritten.
    expect(texts.indexOf("write the hero")).toBe(0);
    expect(texts.indexOf("what time is it")).toBeLessThan(texts.indexOf("second answer"));
    expect(new Set(stored.map((message) => message.id)).size).toBe(4);
  });
});

describe("parallel limits", () => {
  test("a thread takes at most maxThreadRuns at once", async () => {
    const { store, Chat, release } = await setup([say("a"), say("b"), say("c")], {
      maxThreadRuns: 2,
    });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "1" });
    const second = await Chat.startTurn({ threadId, text: "2", ifBusy: "parallel" });
    const refused = await Chat.startTurn({ threadId, text: "3", ifBusy: "parallel" }).catch(
      (error) => error,
    );
    expect(refused).toBeInstanceOf(AgentTurnError);
    expect(refused).toMatchObject({ status: 429, code: "too_many_runs" });
    release(0);
    release(1);
    await Promise.all([first.result(), second.result()]);
  });

  test("each parallel run takes a maxConcurrentRuns slot of its own", async () => {
    const { store, Chat, release } = await setup([say("a"), say("b")], { maxConcurrentRuns: 1 });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "1", user: { id: 1 } });
    await expect(
      Chat.startTurn({ threadId, text: "2", user: { id: 1 }, ifBusy: "parallel" }),
    ).rejects.toMatchObject({ status: 429, code: "too_many_runs" });
    // A join adds no run, so it is not refused.
    const joined = (await Chat.startTurn({
      threadId,
      text: "2",
      user: { id: 1 },
      ifBusy: "join",
    })) as AgentTurn;
    expect(joined.joined).toBe(true);
    release(0);
    release(1);
    await first.result();
  });

  test("stop by thread stops every run going on it; watch announces each, attach finds each by id", async () => {
    const { store, Chat, release, liveRuns } = await setup([say("a"), say("b")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "1" });
    const second = await Chat.startTurn({ threadId, text: "2", ifBusy: "parallel" });

    const watch = await new Chat().watch(request("/watch", { threadId }));
    const announced: string[] = [];
    for await (const frame of decodeSSE(watch.body)) {
      if (frame.event.type === "run-start") announced.push(frame.event.runId);
      if (announced.length === 2) break;
    }
    expect(announced).toEqual([first.runId, second.runId]);

    const attached = await new Chat().attach(
      request("/attach", { threadId, runId: first.runId, cursor: -1 }),
    );
    const reading = framesOf(attached);

    const stopped = await new Chat().stop(request("/stop", { threadId }));
    expect(stopped).toEqual({ stopped: true });
    release(0);
    release(1);
    expect((await first.result()).finishReason).toBe("aborted");
    expect((await second.result()).finishReason).toBe("aborted");
    const frames = await reading;
    expect(frames[0]!.event).toMatchObject({ type: "run-start", runId: first.runId });
    expect(liveRuns.running({ threadId })).toEqual([]);
  });
});

describe("busyPolicy", () => {
  test("is asked only on a busy thread, with what is going and what was asked for", async () => {
    const { store, Chat, release, asked, calls } = await setup([say("a"), say("b")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "write the hero", user: { id: 1 } });
    expect(asked).toEqual([]);
    await until(() => calls() === 1);

    await Chat.startTurn({ threadId, text: "make it blue", user: { id: 1 }, ifBusy: "join" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      threadId,
      requested: "join",
      source: "server",
      owner: "user:1",
      turn: { text: "make it blue" },
      running: [
        {
          runId: first.runId,
          owner: "user:1",
          turn: { text: "write the hero" },
          joined: [],
        },
      ],
    });
    expect(asked[0]!.running[0]!.startedAt).toBeInstanceOf(Date);

    // What joined is listed for the next turn's question.
    await Chat.startTurn({ threadId, text: "and bigger", user: { id: 1 }, ifBusy: "join" });
    expect(asked[1]!.running[0]!.joined).toEqual([{ text: "make it blue" }]);
    release(0);
    release(1);
    await first.result();
  });

  test("decides per message: join when it is about the running turn, parallel otherwise", async () => {
    const { store, Chat, release, calls } = await setup([say("a"), say("b"), say("c")], {
      busyPolicy: ({ turn }) => (turn?.text?.startsWith("also") ? "join" : "parallel"),
    });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "write the hero" });
    await until(() => calls() === 1);

    const joined = (await Chat.startTurn({ threadId, text: "also make it blue" })) as AgentTurn;
    expect(joined.joined).toBe(true);
    const beside = (await Chat.startTurn({ threadId, text: "unrelated question" })) as AgentTurn;
    expect(beside.joined).toBe(false);
    expect(beside.runId).not.toBe(first.runId);

    release(0);
    release(1);
    release(2);
    await Promise.all([first.result(), beside.result()]);
    const stored = (await store.loadThread(threadId))!;
    expect(stored.find((message) => textOf(message) === "also make it blue")?.joined).toBe(true);
    expect(stored.find((message) => textOf(message) === "unrelated question")?.joined).toBeUndefined();
  });

  test("decides for client turns too, over the client's ifBusy", async () => {
    const { store, Chat, release, asked } = await setup([say("a"), say("b")], {
      busyPolicy: () => "parallel",
    });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    const response = await new Chat().stream(
      request("", { threadId, turn: { text: "two" }, ifBusy: "join" }),
    );
    expect(asked[0]).toMatchObject({ requested: "join", source: "client", turn: { text: "two" } });
    const reading = framesOf(response);
    release(0);
    release(1);
    const frames = await reading;
    const start = frames[0]!.event as { type: string; runId: string };
    expect(start.type).toBe("run-start");
    expect(start.runId).not.toBe(first.runId);
    expect((await first.result()).finishReason).toBe("stop");
  });

  test("the default answers the request, supersede when none was made", async () => {
    const { store, Chat, release } = await setup([say("a"), say("b")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    const second = await Chat.startTurn({ threadId, text: "again" });
    release(0);
    release(1);
    expect((await first.result()).finishReason).toBe("aborted");
    expect((await second.result()).text).toBe("b");
  });

  test("an answer it does not know fails the turn", async () => {
    const { store, Chat, release } = await setup([say("a")], {
      busyPolicy: () => "later" as never,
    });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    await expect(Chat.startTurn({ threadId, text: "two" })).rejects.toThrow(/busyPolicy/);
    release(0);
    await first.result();
  });

  test("skip from the hook answers a client turn 409 thread_busy", async () => {
    const { store, Chat, release } = await setup([say("a")], { busyPolicy: () => "skip" });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    const response = await new Chat().stream(request("", { threadId, turn: { text: "two" } }));
    expect(response.status).toBe(409);
    release(0);
    await first.result();
  });
});
