process.env.SECRET ??= "agent-controller-watch-test-secret";

import { describe, expect, test } from "vitest";

import { InsufficientPermissionsError } from "../http/errors";
import { HttpRequest } from "../http/HttpRequest";
import { Agent } from "./Agent";
import {
  AgentController,
  type AuthorizeRequestParams,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { decodeSSE } from "./client/sse";
import { fakeProvider } from "./providers/fakeProvider";

/**
 * #1180: `POST /<path>/watch` announces every run that starts on a thread,
 * so an open chat can attach to a turn it did not start.
 */

const finish: ProviderEvent = {
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function jsonRequest(path: string, body: unknown) {
  const raw = new Request(`http://localhost/api/chat${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", `/chat${path}`);
}

function setup() {
  const store = new MemoryAgentStore();
  const liveRuns = new MemoryLiveRuns();
  const provider = fakeProvider(
    [{ type: "text-delta", delta: "one" }, finish],
    [{ type: "text-delta", delta: "two" }, finish],
  );
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const script = provider.stream.bind(provider);
  provider.stream = (params) =>
    (async function* () {
      await gate;
      yield* script(params);
    })();
  const authorized: AuthorizeRequestParams[] = [];
  class Chat extends AgentController<any> {
    agent = Agent.create({ name: "watch-chat", provider }) as any;
    store = store;
    liveRuns = liveRuns;
    static refuse = false;
    protected authorizeRequest(_req: HttpRequest<any, any>, params: AuthorizeRequestParams) {
      authorized.push(params);
      if (Chat.refuse) throw new InsufficientPermissionsError();
    }
  }
  return { store, Chat, open, authorized };
}

/** Reads `count` announcements off a watch response, then closes it. */
async function announced(response: Response, count: number) {
  const runIds: string[] = [];
  for await (const frame of decodeSSE(response.body)) {
    if (frame.event.type === "run-start") runIds.push(frame.event.runId);
    if (runIds.length === count) break;
  }
  return runIds;
}

describe("AgentController.watch", () => {
  test("announces a run a server turn starts on the thread, authorized as attach", async () => {
    const { store, Chat, open, authorized } = setup();
    const { threadId } = await store.createThread({});
    const response = await new Chat().watch(jsonRequest("/watch", { threadId }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(authorized).toEqual([{ route: "attach", threadId }]);

    const reading = announced(response, 1);
    const turn = await Chat.startTurn({ threadId, text: "hi" });
    expect(await reading).toEqual([turn.runId]);
    open();
    await turn.result();
  });

  test("announces a run already going when it connects, then each new one", async () => {
    const { store, Chat, open } = setup();
    const { threadId } = await store.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi" });
    const response = await new Chat().watch(jsonRequest("/watch", { threadId }));
    const reading = announced(response, 2);
    open();
    await first.result();
    const second = await Chat.startTurn({ threadId, text: "again" });
    expect(await reading).toEqual([first.runId, second.runId]);
    await second.result();
  });

  test("does not announce another thread's runs, nor another owner's", async () => {
    const { store, Chat, open } = setup();
    const { threadId } = await store.createThread({});
    const other = await store.createThread({});
    const response = await new Chat().watch(jsonRequest("/watch", { threadId }));
    const reading = announced(response, 1);

    // Another thread: nothing.
    const elsewhere = await Chat.startTurn({ threadId: other.threadId, text: "x" });
    // This thread, but someone else's run: this anonymous caller may not attach to it.
    const owned = await Chat.startTurn({ threadId, text: "mine", user: { id: 7 } });
    open();
    await Promise.all([elsewhere.result(), owned.result()]);
    // An anonymous run on the thread: announced.
    const anonymous = await Chat.startTurn({ threadId, text: "anyone" });
    expect(await reading).toEqual([anonymous.runId]);
    await anonymous.result();
  });

  test("a refused caller gets nothing", async () => {
    const { store, Chat } = setup();
    const { threadId } = await store.createThread({});
    Chat.refuse = true;
    await expect(new Chat().watch(jsonRequest("/watch", { threadId }))).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );
  });

  test("needs a threadId", async () => {
    const { Chat } = setup();
    const response = await new Chat().watch(jsonRequest("/watch", {}));
    expect(response.status).toBe(400);
  });
});
