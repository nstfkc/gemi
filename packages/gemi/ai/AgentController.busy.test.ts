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
  type ThreadRunLimit,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { decodeSSE } from "./client/sse";
import { splitTurns, turnStarts } from "./contextWindow";
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
/** A model call that fails, in place of a script. */
const FAILS = new Error("the model call failed");

async function setup(
  scripts: (ProviderEvent[] | Error)[],
  options: {
    store?: AgentStore;
    maxSteps?: number;
    busyPolicy?: (params: BusyPolicyParams<Body>) => AgentTurnBusyPolicy;
    maxThreadRuns?: ThreadRunLimit;
    maxConcurrentRuns?: number;
    tools?: any[];
  } = {},
) {
  const store = options.store ?? new MemoryAgentStore();
  const liveRuns = new MemoryLiveRuns();
  const provider = fakeProvider();
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
      const script = scripts[index] ?? [finish()];
      if (script instanceof Error) throw script;
      yield* script;
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
    // It names the turn it joined.
    expect(stored[2]).toMatchObject({ role: "user", joined: stored[0]!.id });
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
    expect(second.at(-1)).toMatchObject({ role: "user", joined: second[0]!.id });
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

  test("a stop drops a joined message the run had not read: no run starts for it, nothing is stored", async () => {
    const { store, Chat, release, calls, liveRuns } = await setup([say("first"), say("second")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    await until(() => calls() === 1);

    const joined = (await Chat.startTurn({ threadId, text: "also this", ifBusy: "join" })) as AgentTurn;
    expect(joined.joined).toBe(true);
    // The person stops the conversation before the run read the message.
    first.stop();
    release(0);
    expect((await first.result()).finishReason).toBe("aborted");

    // The joined turn's outcome is the stopped run's.
    const result = await joined.result();
    expect(result.runId).toBe(first.runId);
    expect(result.finishReason).toBe("aborted");
    await tick();
    await tick();
    expect(calls()).toBe(1);
    expect(liveRuns.running({ threadId })).toEqual([]);
    const stored = (await store.loadThread(threadId))!;
    expect(stored.map(textOf)).toEqual(["hi", ""]);
  });

  test("a stop from the route drops it too, and the joined stream just ends", async () => {
    const { store, Chat, release, calls } = await setup([say("first"), say("second")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    await until(() => calls() === 1);

    const response = await new Chat().stream(
      request("", { threadId, turn: { text: "also this", localId: "local_1" }, ifBusy: "join" }),
    );
    const reading = framesOf(response);
    expect(await new Chat().stop(request("/stop", { runId: first.runId }))).toEqual({
      stopped: true,
    });
    release(0);
    const frames = await reading;
    expect(frames.filter((frame) => frame.event.type === "run-start")).toHaveLength(1);
    expect(frames.at(-1)!.event).toMatchObject({ type: "run-end", finishReason: "aborted" });
    await tick();
    expect(calls()).toBe(1);
    expect((await store.loadThread(threadId))!.map(textOf)).toEqual(["hi", ""]);
  });

  test("a run that fails before reading the message hands it to a turn of its own", async () => {
    const { store, provider, Chat, release, calls } = await setup([FAILS, say("second")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    await until(() => calls() === 1);

    const joined = (await Chat.startTurn({ threadId, text: "also this", ifBusy: "join" })) as AgentTurn;
    release(0);
    expect((await first.result()).finishReason).toBe("error");

    await until(() => calls() === 2);
    release(1);
    const result = await joined.result();
    expect(result.text).toBe("second");
    expect(result.runId).not.toBe(first.runId);
    expect(textOf(provider.calls[1]!.messages.at(-1) as AgentMessage)).toBe("also this");
    const stored = (await store.loadThread(threadId))!;
    expect(stored.map(textOf).slice(-2)).toEqual(["also this", "second"]);
    expect(stored.at(-2)!.joined).toBeUndefined();
  });

  test("a message whose run was superseded joins the run that superseded it, and result() is that run's", async () => {
    const { store, provider, Chat, release, calls } = await setup([
      say("first"),
      say("both answered"),
    ]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    await until(() => calls() === 1);
    const joined = (await Chat.startTurn({ threadId, text: "also this", ifBusy: "join" })) as AgentTurn;

    // A turn that supersedes: the run is stopped by it, not by a caller.
    const superseding = Chat.startTurn({ threadId, text: "new topic" });
    await tick();
    release(0);
    const next = await superseding;
    expect((await first.result()).finishReason).toBe("aborted");

    // The joined message tries again and joins the new run, which reads it
    // with its own message.
    await until(() => calls() === 2);
    release(1);
    const result = await joined.result();
    expect(result.runId).toBe(next.runId);
    expect(result.text).toBe("both answered");
    expect(provider.calls[1]!.messages.map((m) => textOf(m as AgentMessage)).slice(-2)).toEqual([
      "new topic",
      "also this",
    ]);
    const stored = (await store.loadThread(threadId))!;
    const also = stored.find((message) => textOf(message) === "also this")!;
    expect(also.joined).toBe(stored.find((message) => textOf(message) === "new topic")!.id);
  });

  test("a joined message whose turn of its own is refused is stored and reported, on the stream and by result()", async () => {
    let asks = 0;
    const { store, Chat, release, calls } = await setup([say("first"), FAILS, FAILS], {
      busyPolicy: ({ turn }) => {
        if (turn?.text === "side") return "parallel";
        // Joins the first time, and is refused (skip) when it tries again.
        return asks++ === 0 ? "join" : "skip";
      },
    });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    const side = await Chat.startTurn({ threadId, text: "side" });
    await until(() => calls() === 2);

    // Joins `side`, the newest run, which then fails before reading it.
    const response = await new Chat().stream(
      request("", { threadId, turn: { text: "also this", localId: "local_3" } }),
    );
    const reading = framesOf(response);
    release(1);
    expect((await side.result()).finishReason).toBe("error");
    const frames = await reading;
    const renamed = frames.find((frame) => frame.event.type === "message-id")!.event as any;
    expect(renamed.localId).toBe("local_3");
    const error = frames.at(-1)!.event as any;
    expect(error.type).toBe("error");
    expect(error.error.message).toMatch(/not answered/);
    // seq goes on from the run's, so the client applies both frames.
    const seqs = frames.map((frame) => frame.seq);
    expect(seqs.at(-1)).toBeGreaterThan(seqs.at(-3)!);

    const stored = (await store.loadThread(threadId))!;
    const kept = stored.find((message) => textOf(message) === "also this")!;
    expect(kept.id).toBe(renamed.messageId);
    expect(kept.joined).toBeUndefined();
    release(0);
    await first.result();
  });

  test("startTurn: result() rejects with the refusal of the turn started for a joined message", async () => {
    let asks = 0;
    const { store, Chat, release, calls } = await setup([say("first"), FAILS], {
      busyPolicy: ({ turn }) => {
        if (turn?.text === "side") return "parallel";
        return asks++ === 0 ? "join" : "skip";
      },
    });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    const side = await Chat.startTurn({ threadId, text: "side" });
    await until(() => calls() === 2);
    const joined = (await Chat.startTurn({ threadId, text: "also this" })) as AgentTurn;
    expect(joined.runId).toBe(side.runId);
    release(1);
    await expect(joined.result()).rejects.toMatchObject({ status: 409 });
    const stored = (await store.loadThread(threadId))!;
    expect(stored.some((message) => textOf(message) === "also this")).toBe(true);
    release(0);
    await first.result();
  });

  test("a run that continues for a joined message after a tool ended its step ends with its later step's reason", async () => {
    let finishTool!: () => void;
    const toolDone = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    let toolStarted = false;
    const publish = AgentTool.create({
      name: "publish",
      description: "Publishes the page",
      inputSchema: s.object({}),
      endsRun: () => "Published.",
      execute: async () => {
        toolStarted = true;
        await toolDone;
        return { ok: true };
      },
    });
    const { store, Chat, release, calls } = await setup(
      [
        [{ type: "tool-call", toolCallId: "call_1", name: "publish", args: "{}" }, finish("tool-calls")],
        [{ type: "text-delta", delta: "cut off" }, { ...finish(), reason: "length" } as ProviderEvent],
      ],
      { tools: [publish] },
    );
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "publish it" });
    release(0);
    await until(() => toolStarted);
    await Chat.startTurn({ threadId, text: "and tell me the url", ifBusy: "join" });
    finishTool();
    await until(() => calls() === 2);
    release(1);
    const result = await first.result();
    expect(result.finishReason).toBe("length");
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
    const { store, Chat, release, calls } = await setup([FAILS, say("second")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    await until(() => calls() === 1);

    const response = await new Chat().stream(
      request("", { threadId, turn: { text: "also this", localId: "local_1" }, ifBusy: "join" }),
    );
    expect(response.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    const reading = framesOf(response);
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
    expect(renamed.message).toMatchObject({ role: "user", joined: expect.any(String) });
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

describe("parallel: each message names its turn (#1339)", () => {
  test("a reply stored after another run's messages still names its own question", async () => {
    const { store, Chat, release, calls } = await setup([say("first answer"), say("second answer")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "write the hero" });
    await until(() => calls() === 1);
    const second = await Chat.startTurn({ threadId, text: "what time is it", ifBusy: "parallel" });
    release(1);
    await second.result();
    release(0);
    await first.result();

    const stored = (await store.loadThread(threadId))!;
    const byText = (text: string) => stored.find((message) => textOf(message) === text)!;
    expect(byText("write the hero").turn).toBe(byText("write the hero").id);
    expect(byText("first answer").turn).toBe(byText("write the hero").id);
    expect(byText("what time is it").turn).toBe(byText("what time is it").id);
    expect(byText("second answer").turn).toBe(byText("what time is it").id);
    // Each reply with its own question, wherever the store put it.
    expect(splitTurns(stored).map((turn) => turn.map(textOf))).toEqual(
      expect.arrayContaining([
        ["write the hero", "first answer"],
        ["what time is it", "second answer"],
      ]),
    );
  });

  /** Two parallel turns, each parked on an approval: "publish home" (asked first), then "publish about". */
  async function twoParked(replies: ProviderEvent[][], options: { nestedB?: boolean } = {}) {
    const approve = AgentTool.create({
      name: "publish",
      description: "Publish",
      inputSchema: s.object({ page: s.string() }),
      requiresApproval: true,
      execute: async ({ page }: { page: string }) => `published ${page}`,
    });
    const ask = (id: string, page: string, name = "publish"): ProviderEvent[] => [
      { type: "tool-call", toolCallId: id, name, args: JSON.stringify({ page }) },
      finish(),
    ];
    // With `nestedB`, B's question is asked by a sub-agent under B's call.
    const clerk = Agent.create({
      name: "clerk",
      provider: fakeProvider(ask("s1", "about"), [{ type: "text-delta", delta: "clerk done" }, finish()]),
      tools: [approve],
    });
    const delegate = AgentTool.create({
      name: "delegate",
      description: "Delegate",
      inputSchema: s.object({ page: s.string() }),
      execute: async ({ page }: { page: string }, ctx: any) => (await ctx.runAgent(clerk, { prompt: page })).finishReason,
    });
    const harness = await setup(
      [ask("cA", "home"), ask("cB", "about", options.nestedB ? "delegate" : "publish"), ...replies],
      { tools: [approve, delegate] },
    );
    const { store, Chat, release, calls } = harness;
    const { threadId } = await store.createThread({});
    const a = await Chat.startTurn({ threadId, text: "publish home" });
    await until(() => calls() === 1);
    const b = await Chat.startTurn({ threadId, text: "publish about", ifBusy: "parallel" });
    release(0);
    release(1);
    const [parkedA, parkedB] = await Promise.all([a.result(), b.result()]);
    const approval = (pending: { toolCallId: string; signature?: string; path?: string[] }) => ({
      toolCallId: pending.toolCallId,
      signature: pending.signature!,
      ...(pending.path ? { path: pending.path } : {}),
      approve: true,
    });
    const answer = async (...pending: { toolCallId: string; signature?: string; path?: string[] }[]) => {
      const turn = await Chat.startTurn({ threadId, turn: { toolResults: pending.map(approval) } });
      release(calls());
      return { turn, result: await turn.result() };
    };
    const stored = async () => {
      const messages = (await store.loadThread(threadId))!;
      return { messages, byText: (text: string) => messages.find((message) => textOf(message) === text)! };
    };
    return { ...harness, threadId, A: parkedA.pending[0]!, B: parkedB.pending[0]!, answer, stored };
  }

  test("answering the later of two turns' questions carries on that turn, not the first one stored", async () => {
    const { A, B, answer, stored } = await twoParked([say("about is live")]);
    const { turn, result } = await answer(B);
    expect(result.text).toBe("about is live");
    const { byText } = await stored();
    expect(turn.run.turn).toEqual({ id: byText("publish about").id, continues: true, answers: [B.toolCallId] });
    expect(byText("about is live").turn).toBe(byText("publish about").id);
    // A's question is A's to answer: still open, still pending, in A's turn (#1355).
    const asking = (await stored()).messages.find((message) =>
      message.content.some((part) => part.type === "tool-call" && part.toolCallId === A.toolCallId),
    )!;
    expect(asking.turn).toBe(byText("publish home").id);
    expect(asking.pending?.map((call) => [call.toolCallId, call.turn])).toEqual([[A.toolCallId, byText("publish home").id]]);
    expect(asking.content.some((part) => part.type === "tool-result")).toBe(false);
    // The frames name each question's turn, which is what lets a client keep A's card.
    expect(A.turn).toBe(byText("publish home").id);
    expect(B.turn).toBe(byText("publish about").id);
  });

  /** The tool result a stored message holds for `toolCallId`, if any. */
  const resultOf = (messages: AgentMessage[], toolCallId: string) =>
    messages
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool-result" && part.toolCallId === toolCallId) as
      | { status: string; cause?: string }
      | undefined;

  test.each([
    ["B then A", (A: any, B: any) => [B, A]],
    ["A then B", (A: any, B: any) => [A, B]],
  ])("two turns' questions answered one at a time (%s): each stays open until its own answer (#1355)", async (_name, order) => {
    const { A, B, answer, stored } = await twoParked([say("first is live"), say("second is live")]);
    const [first, second] = order(A, B) as [typeof A, typeof B];
    const one = await answer(first);
    expect(one.result.finishReason).toBe("stop");
    // The other question is still open after the first answer.
    expect(resultOf((await stored()).messages, second.toolCallId)).toBeUndefined();

    const two = await answer(second);
    expect(two.result.finishReason).toBe("stop");
    expect(two.result.error).toBeUndefined();

    const { messages, byText } = await stored();
    expect(resultOf(messages, A.toolCallId)?.status).toBe("ok");
    expect(resultOf(messages, B.toolCallId)?.status).toBe("ok");
    const turnOf = (pending: { toolCallId: string }) => (pending === A ? "publish home" : "publish about");
    expect(one.turn.run.turn?.id).toBe(byText(turnOf(first)).id);
    expect(two.turn.run.turn?.id).toBe(byText(turnOf(second)).id);
    expect(byText("first is live").turn).toBe(byText(turnOf(first)).id);
    expect(byText("second is live").turn).toBe(byText(turnOf(second)).id);
    expect(messages.every((message) => message.pending === undefined)).toBe(true);
  });

  test.each([
    ["parallel", "parallel" as const, undefined],
    ["the default", undefined, "denied"],
  ])("a new message asked as %s: the questions other turns wait on stay open, or are refused as before", async (_name, ifBusy, status) => {
    const { A, B, stored, Chat, threadId, release, calls } = await twoParked([say("noted")]);
    const turn = await Chat.startTurn({ threadId, text: "something else", ...(ifBusy ? { ifBusy } : {}) });
    release(calls());
    await turn.result();
    const { messages } = await stored();
    expect(resultOf(messages, A.toolCallId)?.status).toBe(status);
    expect(resultOf(messages, B.toolCallId)?.status).toBe(status);
    if (status) {
      expect(resultOf(messages, A.toolCallId)?.cause).toBe("refused");
      expect(resultOf(messages, B.toolCallId)?.cause).toBe("refused");
    }
  });

  test("the same answer sent twice ends the second as stale, and refuses nothing", async () => {
    const { A, B, answer, stored, calls } = await twoParked([say("about is live")]);
    await answer(B);
    const before = calls();
    const again = await answer(B);
    expect(again.result.finishReason).toBe("error");
    expect(again.result.error?.code).toBe("invalid_tool_result");
    expect(calls()).toBe(before);
    const { messages } = await stored();
    expect(resultOf(messages, A.toolCallId)).toBeUndefined();
    expect(messages.some((message) => message.pending?.some((call) => call.toolCallId === A.toolCallId))).toBe(true);
  });

  test("an answer to a sub-agent's question in turn B carries on B, and leaves A open", async () => {
    const { A, B, answer, stored } = await twoParked([say("about is live")], { nestedB: true });
    expect(B).toMatchObject({ toolCallId: "s1", path: ["cB"] });
    const { turn, result } = await answer(B);
    expect(result.text).toBe("about is live");
    const { messages, byText } = await stored();
    expect(turn.run.turn?.id).toBe(byText("publish about").id);
    expect(resultOf(messages, "cB")?.status).toBe("ok");
    expect(resultOf(messages, A.toolCallId)).toBeUndefined();
  });

  test("a stop ends the stopped run's turn, not the question another turn waits on", async () => {
    const { A, B, stored, Chat, threadId, calls } = await twoParked([say("never")]);
    const turn = await Chat.startTurn({
      threadId,
      turn: { toolResults: [{ toolCallId: B.toolCallId, signature: B.signature!, approve: true }] },
    });
    await until(() => calls() === 3);
    await turn.stop();
    expect((await turn.result()).finishReason).toBe("aborted");
    const { messages } = await stored();
    expect(resultOf(messages, B.toolCallId)?.status).toBe("ok");
    expect(resultOf(messages, A.toolCallId)).toBeUndefined();
  });

  test("one request answering both, the later first: it carries on the turn of the first answer it lists", async () => {
    const { A, B, answer, stored } = await twoParked([say("both are live")]);
    const { turn } = await answer(B, A);
    await turn.result();
    const { byText } = await stored();
    expect(turn.run.turn?.id).toBe(byText("publish about").id);
    expect(byText("both are live").turn).toBe(byText("publish about").id);
  });

  test("busyPolicy sees each running run's turn id and the body that started it", async () => {
    const { store, Chat, release, asked, calls } = await setup([say("a"), say("b")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "write the hero", body: { pageId: "p_1" } });
    await until(() => calls() === 1);
    await Chat.startTurn({ threadId, text: "make it blue", ifBusy: "join" });
    const stored = (await store.loadThread(threadId))!;
    expect(asked[0]!.running[0]).toMatchObject({
      runId: first.runId,
      messageId: stored.find((message) => textOf(message) === "write the hero")!.id,
      body: { pageId: "p_1" },
    });
    release(0);
    release(1);
    await first.result();
    // The joined message names the turn it joined, as `joined` still does.
    const after = (await store.loadThread(threadId))!;
    const joined = after.find((message) => textOf(message) === "make it blue")!;
    expect(joined.turn).toBe(asked[0]!.running[0]!.messageId);
    expect(joined.joined).toBe(joined.turn);
  });

  test("overflow: queue holds a parallel turn past maxThreadRuns until a run ends, then starts it", async () => {
    const { store, Chat, release, calls } = await setup([say("a"), say("b"), say("c")], {
      maxThreadRuns: { max: 2, overflow: "queue" },
    });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "1" });
    const second = await Chat.startTurn({ threadId, text: "2", ifBusy: "parallel" });
    let third: AgentTurn | undefined;
    const starting = Chat.startTurn({ threadId, text: "3", ifBusy: "parallel" }).then((turn) => {
      third = turn as AgentTurn;
    });
    await until(() => calls() === 2);
    await tick();
    await tick();
    // Held, not refused, while two are going.
    expect(third).toBeUndefined();
    expect(calls()).toBe(2);

    release(1);
    await second.result();
    await starting;
    expect(third!.joined).toBe(false);
    await until(() => calls() === 3);
    release(2);
    expect((await third!.result()).text).toBe("c");
    release(0);
    await first.result();
  });

  test.each([
    ["NaN", Number.NaN],
    ["zero", 0],
    ["a fraction", 1.5],
    ["an unknown overflow", { max: 2, overflow: "Queue" }],
  ])("a maxThreadRuns answer that is %s fails the turn", async (_name, limit) => {
    const { store, Chat, release } = await setup([say("a")], { maxThreadRuns: limit as ThreadRunLimit });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "1" });
    await expect(Chat.startTurn({ threadId, text: "2", ifBusy: "parallel" })).rejects.toThrow(/maxThreadRuns/);
    release(0);
    await first.result();
  });

  test("overflow: reject is the bare number's 429", async () => {
    const { store, Chat, release } = await setup([say("a"), say("b")], {
      maxThreadRuns: { max: 1, overflow: "reject" },
    });
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "1" });
    await expect(Chat.startTurn({ threadId, text: "2", ifBusy: "parallel" })).rejects.toMatchObject({
      status: 429,
      code: "too_many_runs",
    });
    release(0);
    await first.result();
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
    expect(stored.find((message) => textOf(message) === "also make it blue")?.joined).toBe(
      stored.find((message) => textOf(message) === "write the hero")!.id,
    );
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

describe("parallel: waiting for the runs going to take their turns in", () => {
  test("is done outside the thread's lock, so a supersede meanwhile is not held up", async () => {
    const { store, Chat, release, calls } = await setup([say("a"), say("b"), say("c")]);
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    // A run that never says it has taken its turn in (a slow tool it
    // re-enters, a slow limiter): its frames go quiet until it ends.
    (first.run as any).frames = () =>
      (async function* (): AsyncGenerator<AgentStreamFrame> {
        await first.run.result();
        yield* [];
      })();

    const parallel = Chat.startTurn({ threadId, text: "side", ifBusy: "parallel" });
    await tick();
    // Superseding takes the lock and starts at once.
    const superseding = await Chat.startTurn({ threadId, text: "replace" });
    release(0);
    expect((await first.result()).finishReason).toBe("aborted");
    // The parallel turn then starts beside the run that superseded.
    const beside = (await parallel) as AgentTurn;
    expect(beside.runId).not.toBe(superseding.runId);
    await until(() => calls() === 3);
    release(1);
    release(2);
    await Promise.all([superseding.result(), beside.result()]);
  });
});
