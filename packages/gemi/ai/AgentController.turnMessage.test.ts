process.env.SECRET ??= "agent-controller-turn-message-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { Agent } from "./Agent";
import {
  AgentController,
  type AgentHookContext,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import type { AgentMessage, AgentStreamFrame } from "./types";

/**
 * #806: the app's `onMessage` for a turn's user message used to fire after
 * the run, with every other message. An app that keeps something beside the
 * stored message (where it was sent from, whether the app sent it for the
 * user) had none of it for the whole run, so a reload or a second tab showed
 * the message untagged until the run ended. It now fires once the journal has
 * written the message, while the model is still being asked, and only once.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(check: () => boolean | Promise<boolean>, ms = 2_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await tick();
  }
}

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

function jsonRequest(body: unknown, path = "/chat") {
  const raw = new Request(`http://localhost/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", path);
}

async function framesOf(response: Response): Promise<AgentStreamFrame[]> {
  const frames: AgentStreamFrame[] = [];
  let seq: number | undefined;
  for (const line of (await response.text()).split("\n")) {
    if (line.startsWith("id: ")) seq = Number(line.slice(4));
    if (line.startsWith("data: ")) {
      frames.push({ seq: seq ?? frames.length, event: JSON.parse(line.slice(6)) });
    }
  }
  return frames;
}

/** A store whose writes a test can hold, to see what waits for them. */
class GatedStore extends MemoryAgentStore {
  gate: Promise<void> | null = null;
  async appendMessages(threadId: string, messages: AgentMessage[]) {
    if (this.gate) await this.gate;
    return super.appendMessages(threadId, messages);
  }
}

function setup(options: { fails?: boolean } = {}) {
  let open!: () => void;
  const modelGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const provider = fakeProvider(
    [{ type: "text-delta", delta: "first" }, finish()],
    [{ type: "text-delta", delta: "second" }, finish()],
  );
  const script = provider.stream.bind(provider);
  /** Model calls made, counted as they are asked rather than as they answer. */
  const asked = { count: 0 };
  provider.stream = (params) =>
    (async function* () {
      asked.count++;
      await modelGate;
      if (options.fails) throw new Error("model unavailable");
      yield* script(params);
    })();

  const store = new GatedStore();
  /** Every `onMessage`, with what the store held for the thread at the time. */
  const seen: { role: string; id: string; stored: string[] }[] = [];

  class Chat extends AgentController {
    agent = Agent.create({ name: "chat", provider }) as any;
    store = store;
    liveRuns = new MemoryLiveRuns();

    protected async onMessage(message: AgentMessage, ctx: AgentHookContext) {
      const held = ctx.threadId ? await this.store.loadThread(ctx.threadId) : null;
      seen.push({
        role: message.role,
        id: message.id,
        stored: (held ?? []).map((m) => m.id),
      });
    }
  }

  return { controller: new Chat(), store, seen, open, asked };
}

const roles = (seen: { role: string }[]) => seen.map((entry) => entry.role);

describe("onMessage for the turn's user message fires while the run goes (#806)", () => {
  test("a threaded turn: before the model answers, after the store has it, and once", async () => {
    const { controller, store, seen, open, asked } = setup();
    const { threadId } = await store.createThread({});

    const response = await controller.stream(jsonRequest({ threadId, turn: { text: "hi" } }));
    await until(() => seen.length === 1);

    // The model has not answered: the run is waiting on it.
    expect(asked.count).toBe(1);
    expect(roles(seen)).toEqual(["user"]);
    // The row an app would tag is already there.
    expect(seen[0]!.stored).toEqual([seen[0]!.id]);

    open();
    await response.text();
    await until(() => seen.length === 2);
    await tick();

    // Once per message, in the transcript's order.
    expect(roles(seen)).toEqual(["user", "assistant"]);
    const stored = (await store.loadThread(threadId))!;
    expect(seen.map((entry) => entry.id)).toEqual(stored.map((m) => m.id));
  });

  test("waits for the journal's write of the message, not just for the run to report it", async () => {
    const { controller, store, seen, open } = setup();
    const { threadId } = await store.createThread({});
    let release!: () => void;
    store.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const response = await controller.stream(jsonRequest({ threadId, turn: { text: "hi" } }));
    await tick();
    expect(seen).toEqual([]);

    release();
    store.gate = null;
    await until(() => seen.length === 1);
    expect(seen[0]!.stored).toEqual([seen[0]!.id]);

    open();
    await response.text();
    await until(() => seen.length === 2);
  });

  test("hands the hook the server's id, the one the client's localId is renamed to", async () => {
    const { controller, store, seen, open } = setup();
    const { threadId } = await store.createThread({});

    const response = await controller.stream(
      jsonRequest({ threadId, turn: { text: "hi", localId: "local_1" } }),
    );
    await until(() => seen.length === 1);
    open();
    const frames = await framesOf(response);
    const rename = frames.find((frame) => frame.event.type === "message-id")!.event as {
      messageId: string;
    };

    expect(seen[0]!.id).toBe(rename.messageId);
    expect(seen[0]!.id).not.toBe("local_1");
  });

  test("a run that fails still has its user message through the hook, once", async () => {
    const { controller, store, seen, open } = setup({ fails: true });
    const { threadId } = await store.createThread({});

    const response = await controller.stream(jsonRequest({ threadId, turn: { text: "hi" } }));
    await until(() => seen.length === 1);
    open();
    await response.text();
    await tick();
    await tick();

    expect(seen.filter((entry) => entry.role === "user")).toHaveLength(1);
    expect(seen[0]!.role).toBe("user");
  });

  test("a stopped run still has its user message through the hook, once", async () => {
    const { controller, store, seen, open } = setup();
    const { threadId } = await store.createThread({});

    const response = await controller.stream(jsonRequest({ threadId, turn: { text: "hi" } }));
    await until(() => seen.length === 1);
    expect(await controller.stop(jsonRequest({ threadId }, "/chat/stop"))).toEqual({
      stopped: true,
    });
    open();
    await response.text();
    await tick();
    await tick();

    expect(seen.filter((entry) => entry.role === "user")).toHaveLength(1);
    expect(seen[0]!.role).toBe("user");
    expect((await store.loadThread(threadId))!.map((m) => m.id)).toContain(seen[0]!.id);
  });

  test("a regenerate hands the hook the turn under its new id", async () => {
    const { controller, store, seen, open } = setup();
    const { threadId } = await store.createThread({});
    open();
    await (await controller.stream(jsonRequest({ threadId, turn: { text: "hi" } }))).text();
    await until(() => seen.length === 2);
    const first = seen[0]!.id;

    await (await controller.stream(jsonRequest({ threadId, regenerate: true }))).text();
    await until(() => seen.length === 4);
    await tick();

    expect(roles(seen)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(seen[2]!.id).not.toBe(first);
    expect((await store.loadThread(threadId))!.map((m) => m.id)).toEqual([
      seen[2]!.id,
      seen[3]!.id,
    ]);
  });

  test("a stateless turn: the same, with no store in between", async () => {
    const { controller, seen, open, asked } = setup();

    const response = await controller.stream(jsonRequest({ messages: [], turn: { text: "hi" } }));
    await until(() => seen.length === 1 && asked.count === 1);
    // The model has been asked and has not answered.
    expect(roles(seen)).toEqual(["user"]);

    open();
    await response.text();
    await until(() => seen.length === 2);
    await tick();
    expect(roles(seen)).toEqual(["user", "assistant"]);
  });
});
