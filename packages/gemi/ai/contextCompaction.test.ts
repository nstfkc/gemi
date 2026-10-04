process.env.SECRET ??= "context-compaction-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { Agent } from "./Agent";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
import type { ProviderEvent, ProviderStreamParams } from "./AgentProvider";
import {
  chunkTurns,
  COMPACT_SUMMARY_HEADER,
  MemorySummaryStore,
  type SummaryStore,
  type ThreadSummary,
} from "./contextCompaction";
import { DEFAULT_CONTEXT_WINDOW_NOTE, turnStarts } from "./contextWindow";
import { fakeProvider } from "./providers/fakeProvider";
import type { AgentMessage } from "./types";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const finish = (tokens = 10): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: tokens, outputTokens: tokens, totalTokens: 2 * tokens },
});

/** A summary call's answer. */
const summaryAnswer = (text: string, tokens = 100): ProviderEvent[] => [
  { type: "output-delta", delta: JSON.stringify({ summary: text }) },
  finish(tokens),
];

const answer = (): ProviderEvent[] => [{ type: "text-delta", delta: "ok" }, finish()];

const msg = (id: string, role: AgentMessage["role"], text: string): AgentMessage => ({
  id,
  role,
  content: [{ type: "text", text }],
  createdAt: new Date(0).toISOString(),
  finishReason: "stop",
});

const thread = (n: number, from = 0): AgentMessage[] =>
  Array.from({ length: n }, (_, k) => {
    const i = k + from;
    return [msg(`u${i}`, "user", `question ${i}`), msg(`a${i}`, "assistant", `answer ${i}`)];
  }).flat();

const ids = (messages: readonly AgentMessage[]) => messages.map((m) => m.id);
const firstText = (message: AgentMessage) =>
  message.content.find((part) => part.type === "text")?.text ?? "";
const promptOf = (call: ProviderStreamParams) =>
  (call.messages as AgentMessage[]).map(firstText).join("\n");

/** 26 turns sent (25 stored and "now"), at most 10, so the cut is at turn 20. */
const window = { maxTurns: 10, step: 10 };

function setup(compact: Record<string, unknown> = {}) {
  const summarizer = fakeProvider(
    summaryAnswer("S1"),
    summaryAnswer("S2"),
    summaryAnswer("S3"),
    summaryAnswer("S4"),
  );
  const provider = fakeProvider(answer(), answer(), answer(), answer());
  const store = new MemorySummaryStore();
  const agent = Agent.create({
    name: "a",
    provider,
    contextWindow: {
      ...window,
      compact: { provider: summarizer, store, ...compact },
    },
  });
  return { agent, provider, summarizer, store };
}

describe("contextWindow.compact", () => {
  test("off unless asked: the plain window is sent and nothing is summarised", async () => {
    const provider = fakeProvider(answer());
    const agent = Agent.create({ name: "a", provider, contextWindow: window });
    await agent.stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" }).result();
    expect(provider.calls).toHaveLength(1);
    const sent = provider.calls[0]!.messages as AgentMessage[];
    expect(sent[0]!.id).toBe("u20");
    expect(firstText(sent[0]!)).toBe(DEFAULT_CONTEXT_WINDOW_NOTE);
  });

  test("the left-out turns are summarised, sent in front of the kept ones, and billed", async () => {
    const { agent, provider, summarizer, store } = setup();
    const result = await agent
      .stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" })
      .result();

    expect(summarizer.calls).toHaveLength(1);
    const prompt = promptOf(summarizer.calls[0]!);
    expect(prompt).toContain("question 0");
    expect(prompt).toContain("answer 19");
    expect(prompt).not.toContain("question 20");
    expect(summarizer.calls[0]!.output).toBeDefined();

    const sent = provider.calls[0]!.messages as AgentMessage[];
    expect(sent[0]!.id).toBe("summary_u20");
    expect(sent[0]!.role).toBe("user");
    expect(firstText(sent[0]!)).toBe(`${COMPACT_SUMMARY_HEADER}\nS1`);
    expect(ids(sent.slice(1, 3))).toEqual(["u20", "a20"]);
    // No note: the summary replaces it.
    expect(firstText(sent[1]!)).toBe("question 20");

    // The summary call's usage is the run's too.
    expect(result.usage.inputTokens).toBe(110);
    expect(result.finishReason).toBe("stop");

    const [saved] = await store.loadSummaries("t");
    expect(saved).toMatchObject({
      cutMessageId: "u20",
      text: "S1",
      turns: 20,
      messages: 40,
    });
    expect(saved!.usage?.inputTokens).toBe(100);
  });

  test("a later turn on the same cut reuses the summary and sends the same prefix", async () => {
    const { agent, provider, summarizer } = setup();
    await agent.stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" }).result();
    await agent.stream({ messages: thread(26), turn: { text: "again" }, threadId: "t" }).result();
    expect(summarizer.calls).toHaveLength(1);
    const first = provider.calls[0]!.messages as AgentMessage[];
    const second = provider.calls[1]!.messages as AgentMessage[];
    expect(JSON.stringify(second.slice(0, 11))).toBe(JSON.stringify(first.slice(0, 11)));
  });

  test("every step of a run reuses it", async () => {
    const summarizer = fakeProvider(summaryAnswer("S1"));
    const provider = fakeProvider(
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          name: "noop",
          args: "{}",
        } as any,
        finish(),
      ],
      answer(),
    );
    const { AgentTool } = await import("./Agent");
    const { s } = await import("./Schema");
    const noop = AgentTool.create({
      name: "noop",
      description: "nothing",
      inputSchema: s.object({}),
      outputSchema: s.string(),
      execute: async () => "done",
    });
    const agent = Agent.create({
      name: "a",
      provider,
      tools: [noop],
      contextWindow: {
        ...window,
        compact: { provider: summarizer, store: new MemorySummaryStore() },
      },
    });
    await agent.stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" }).result();
    expect(provider.calls).toHaveLength(2);
    expect(summarizer.calls).toHaveLength(1);
    expect((provider.calls[1]!.messages as AgentMessage[])[0]!.id).toBe("summary_u20");
  });

  test("when the window moves, the new summary builds on the previous one", async () => {
    const { agent, summarizer, provider } = setup();
    await agent.stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" }).result();
    // 36 turns sent: the cut moves to turn 30.
    await agent.stream({ messages: thread(35), turn: { text: "later" }, threadId: "t" }).result();

    expect(summarizer.calls).toHaveLength(2);
    const prompt = promptOf(summarizer.calls[1]!);
    expect(prompt).toContain("Summary so far:\nS1");
    expect(prompt).toContain("question 20");
    expect(prompt).toContain("answer 29");
    expect(prompt).not.toContain("question 19");
    expect(prompt).not.toContain("question 30");
    const sent = provider.calls[1]!.messages as AgentMessage[];
    expect(firstText(sent[0]!)).toBe(`${COMPACT_SUMMARY_HEADER}\nS2`);
    expect(sent[1]!.id).toBe("u30");
  });

  test("a thread whose summarised messages changed is summarised again", async () => {
    const { agent, summarizer } = setup();
    await agent.stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" }).result();
    const edited = thread(25);
    edited[6] = msg("u3", "user", "a different question");
    await agent.stream({ messages: edited, turn: { text: "now" }, threadId: "t" }).result();
    expect(summarizer.calls).toHaveLength(2);
    const prompt = promptOf(summarizer.calls[1]!);
    expect(prompt).toContain("(none yet");
    expect(prompt).toContain("a different question");
  });

  test("a long left-out part is folded in chunks, each building on the last", async () => {
    const { agent, summarizer, provider } = setup({ chunkTokens: 100 });
    await agent.stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" }).result();
    expect(summarizer.calls.length).toBeGreaterThan(1);
    expect(promptOf(summarizer.calls[1]!)).toContain("Summary so far:\nS1");
    const last = summarizer.calls.length;
    const sent = provider.calls[0]!.messages as AgentMessage[];
    expect(firstText(sent[0]!)).toBe(`${COMPACT_SUMMARY_HEADER}\nS${last}`);
  });

  test("a failed summary sends the plain window with its note, and the run goes on", async () => {
    const summarizer = fakeProvider([
      {
        type: "error",
        error: { code: "provider_error", message: "down", retryable: true },
      } as ProviderEvent,
      finish(7),
    ]);
    const provider = fakeProvider(answer());
    const store = new MemorySummaryStore();
    const agent = Agent.create({
      name: "a",
      provider,
      contextWindow: { ...window, compact: { provider: summarizer, store } },
    });
    const result = await agent
      .stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" })
      .result();
    expect(result.finishReason).toBe("stop");
    const sent = provider.calls[0]!.messages as AgentMessage[];
    expect(sent[0]!.id).toBe("u20");
    expect(firstText(sent[0]!)).toBe(DEFAULT_CONTEXT_WINDOW_NOTE);
    expect(await store.loadSummaries("t")).toEqual([]);
    expect(result.usage.inputTokens).toBe(17);
  });

  test("a summary that failed is not tried again on the run's next step", async () => {
    const failing: ProviderEvent[] = [
      { type: "error", error: { code: "provider_error", message: "down", retryable: true } } as any,
    ];
    const summarizer = fakeProvider(failing, failing);
    const provider = fakeProvider(
      [{ type: "tool-call", toolCallId: "c1", name: "noop", args: "{}" } as any, finish()],
      answer(),
    );
    const { AgentTool } = await import("./Agent");
    const { s } = await import("./Schema");
    const noop = AgentTool.create({
      name: "noop",
      description: "nothing",
      inputSchema: s.object({}),
      outputSchema: s.string(),
      execute: async () => "done",
    });
    const agent = Agent.create({
      name: "a",
      provider,
      tools: [noop],
      logErrors: false,
      contextWindow: {
        ...window,
        compact: { provider: summarizer, store: new MemorySummaryStore() },
      },
    });
    const result = await agent
      .stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" })
      .result();
    expect(result.finishReason).toBe("stop");
    expect(provider.calls).toHaveLength(2);
    expect(summarizer.calls).toHaveLength(1);
  });

  test("without a threadId, or in a sub-run, the plain window is sent", async () => {
    const { agent, summarizer, provider } = setup();
    await agent.stream({ messages: thread(25), turn: { text: "now" } }).result();
    expect(summarizer.calls).toHaveLength(0);
    expect((provider.calls[0]!.messages as AgentMessage[])[0]!.id).toBe("u20");
  });

  test("concurrent runs on one thread share one summary call", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const summarizer = {
      ...fakeProvider(),
      model: "slow",
      capabilities: { structuredOutput: true, reasoning: true },
      stream() {
        calls++;
        return (async function* () {
          await gate;
          yield* summaryAnswer("S");
        })();
      },
      normalizeError: (e: unknown) => ({
        code: "provider_error",
        message: String(e),
        retryable: false,
      }),
    } as any;
    const provider = fakeProvider(answer(), answer());
    const agent = Agent.create({
      name: "a",
      provider,
      contextWindow: {
        ...window,
        compact: { provider: summarizer, store: new MemorySummaryStore() },
      },
    });
    const one = agent
      .stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" })
      .result();
    const two = agent
      .stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" })
      .result();
    await settle();
    release();
    await Promise.all([one, two]);
    expect(calls).toBe(1);
    for (const call of provider.calls) {
      expect((call.messages as AgentMessage[])[0]!.id).toBe("summary_u20");
    }
  });

  test("a cut locked by another process is waited for, then read from the store", async () => {
    const inner = new MemorySummaryStore();
    let locks = 0;
    const store: SummaryStore = {
      loadSummaries: (id) => inner.loadSummaries(id),
      saveSummary: (id, summary) => inner.saveSummary(id, summary),
      lockSummary: async () => {
        locks++;
        return null;
      },
    };
    const { agent, summarizer, provider } = setup({ store, lockWaitMs: 2_000 });
    const run = agent
      .stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" })
      .result();
    // The other process finishes its summary.
    setTimeout(async () => {
      const current = (await inner.loadSummaries("t"))[0];
      void current;
      const { prefixFingerprints } = await import("./contextCompaction");
      const all = thread(25);
      await inner.saveSummary("t", {
        cutMessageId: "u20",
        text: "theirs",
        turns: 20,
        messages: 40,
        fingerprint: prefixFingerprints(all, 40)[40]!,
        createdAt: new Date().toISOString(),
      } satisfies ThreadSummary);
    }, 300);
    await run;
    expect(locks).toBe(1);
    expect(summarizer.calls).toHaveLength(0);
    expect(firstText((provider.calls[0]!.messages as AgentMessage[])[0]!)).toBe(
      `${COMPACT_SUMMARY_HEADER}\ntheirs`,
    );
  });

  test("a lock that is never released falls back to the plain window", async () => {
    const store: SummaryStore = {
      loadSummaries: async () => [],
      saveSummary: async () => {},
      lockSummary: async () => null,
    };
    const { agent, summarizer, provider } = setup({ store, lockWaitMs: 300 });
    const result = await agent
      .stream({ messages: thread(25), turn: { text: "now" }, threadId: "t" })
      .result();
    expect(result.finishReason).toBe("stop");
    expect(summarizer.calls).toHaveLength(0);
    expect(firstText((provider.calls[0]!.messages as AgentMessage[])[0]!)).toBe(
      DEFAULT_CONTEXT_WINDOW_NOTE,
    );
  });

  test("the summary's size is reserved from the token budget", async () => {
    const { agent, provider } = setup();
    const big = thread(25);
    const size = JSON.stringify(big.slice(-6)).length;
    // Without the reserve, turns 15.. would fit (step 1); with it, fewer do.
    const runAgent = Agent.create({
      name: "b",
      provider,
      contextWindow: {
        step: 1,
        maxBytes: size + 4 * 50,
        compact: {
          provider: fakeProvider(summaryAnswer("S")),
          store: new MemorySummaryStore(),
          maxSummaryTokens: 50,
        },
      },
    });
    void agent;
    await runAgent.stream({ messages: big, threadId: "t" }).result();
    const sent = provider.calls[0]!.messages as AgentMessage[];
    expect(sent[0]!.id).toBe("summary_u22");
    expect(sent.length - 1).toBeLessThanOrEqual(6);
  });

  test("the cut keeps a tool call with its result, and carries a dropped tool search", async () => {
    const search = {
      namespaces: ["crm"],
      loaded: ["getOrder"],
      arguments: { q: "orders" },
    };
    const toolTurn = (i: number, withSearch: boolean): AgentMessage[] => [
      msg(`u${i}`, "user", `question ${i}`),
      {
        ...msg(`a${i}`, "assistant", ""),
        content: [
          {
            type: "tool-call",
            toolCallId: `c${i}`,
            name: "getOrder",
            namespace: "crm",
            input: { id: i },
            ...(withSearch ? { toolSearches: [search] } : {}),
          },
          {
            type: "tool-result",
            toolCallId: `c${i}`,
            name: "getOrder",
            status: "ok",
            output: { total: i },
          },
        ] as any,
      },
    ];
    const history = [
      ...toolTurn(0, true),
      ...thread(19, 1),
      ...toolTurn(20, false),
      ...thread(4, 21),
    ];
    const { agent, provider, summarizer } = setup();
    await agent.stream({ messages: history, turn: { text: "now" }, threadId: "t" }).result();
    expect(promptOf(summarizer.calls[0]!)).toContain('[called crm.getOrder({"id":0})]');
    expect(promptOf(summarizer.calls[0]!)).toContain('[getOrder returned: {"total":0}]');
    const sent = provider.calls[0]!.messages as AgentMessage[];
    expect(sent[1]!.id).toBe("u20");
    const call = sent[2]!.content[0] as any;
    expect(call.toolSearches).toEqual([search]);
    expect(sent[2]!.content[1]!.type).toBe("tool-result");
  });
});

describe("chunkTurns", () => {
  test("whole turns per chunk, a turn over the limit alone", () => {
    const history = [
      ...thread(3),
      msg("u3", "user", "x".repeat(5_000)),
      msg("a3", "assistant", "y"),
    ];
    const starts = turnStarts(history);
    const chunks = chunkTurns(history, starts, 0, history.length, 600);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("User: question 0");
    expect(chunks[0]).toContain("Assistant: answer 2");
    expect(chunks[1]).toContain("…[cut]");
  });
});

describe("AgentController: compaction", () => {
  test("summaries are kept in the controller's MemoryAgentStore, with the thread", async () => {
    const summarizer = fakeProvider(summaryAnswer("S1"));
    const provider = fakeProvider(answer());
    const agent = Agent.create({ name: "chat", provider });
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, thread(25));
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = store;
      contextWindow = { ...window, compact: { provider: summarizer } };
    }
    const raw = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, turn: { text: "now" } }),
    });
    const response = await new Chat().stream(new HttpRequest(raw, {}, "api", "/chat"));
    await response.text();
    await settle();

    expect(summarizer.calls).toHaveLength(1);
    expect((provider.calls[0]!.messages as AgentMessage[])[0]!.id).toBe("summary_u20");
    const summaries = await store.loadSummaries(threadId);
    expect(summaries.map((s) => s.cutMessageId)).toEqual(["u20"]);
    // The thread itself holds no summary message.
    const held = (await store.loadThread(threadId))!;
    expect(held.some((m) => m.id.startsWith("summary_"))).toBe(false);
    store.delete(threadId);
    expect(await store.loadSummaries(threadId)).toEqual([]);
  });
});
