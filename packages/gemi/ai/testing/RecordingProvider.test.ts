import { describe, expect, test } from "vitest";

import { Agent, AgentTool } from "../Agent";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderStreamParams,
  ProviderToolSpec,
} from "../AgentProvider";
import { fakeProvider } from "../providers/fakeProvider";
import { s } from "../Schema";
import type { AgentMessage } from "../types";
import { pinClock } from "./pinClock";
import { type Recording, RecordingMismatchError, RecordingProvider } from "./RecordingProvider";

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const say = (text: string): ProviderEvent[] => [
  { type: "text-delta", delta: text.slice(0, 2) },
  { type: "text-delta", delta: text.slice(2) },
  finish(),
];
const call = (id: string, name: string, args: unknown): ProviderEvent[] => [
  { type: "tool-call", toolCallId: id, name, args: JSON.stringify(args) },
  finish(),
];

const user = (text: string, id = crypto.randomUUID()): AgentMessage => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  createdAt: new Date().toISOString(),
});

const tool = (name: string, properties: Record<string, unknown>): ProviderToolSpec => ({
  name,
  description: name,
  parameters: { type: "object", properties, additionalProperties: false } as never,
  strict: false,
});

async function drain(provider: AgentProvider, params: ProviderStreamParams) {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(params)) events.push(event);
  return events;
}

/** Records `calls` against a fake live provider answering `scripts`, and answers the recording. */
async function recordCalls(scripts: ProviderEvent[][], calls: ProviderStreamParams[]) {
  const live = fakeProvider(...scripts);
  const recorder = RecordingProvider.record(live as unknown as AgentProvider);
  for (const params of calls) await drain(recorder, params);
  return { recording: JSON.parse(JSON.stringify(recorder.recording())) as Recording, live };
}

describe("record and replay", () => {
  test("replays what was recorded, with no live provider", async () => {
    const first = { systemPrompt: "Be brief.", messages: [user("hi")] };
    const { recording } = await recordCalls([say("hello")], [first]);
    expect(recording.version).toBe(1);
    // Consecutive deltas are kept as one.
    expect(recording.calls[0]!.events[0]).toEqual({ type: "text-delta", delta: "hello" });

    const replay = RecordingProvider.replay(recording);
    const events = await drain(replay, { systemPrompt: "Be brief.", messages: [user("hi")] });
    expect(events.filter((e) => e.type === "text-delta")).toEqual([
      { type: "text-delta", delta: "hello" },
    ]);
    expect(replay.replayedInFull()).toBe(true);
    expect(replay.stale.size).toBe(0);
    await expect(
      drain(replay, { systemPrompt: "Be brief.", messages: [user("hi")] }),
    ).rejects.toThrow(RecordingMismatchError);
  });

  test("records only the messages new since the call before", async () => {
    const one = [user("a")];
    const two = [...one, user("b")];
    const { recording } = await recordCalls(
      [say("x"), say("y")],
      [{ messages: one }, { messages: two }],
    );
    expect(recording.calls[1]!.request.after).toBe(1);
    expect(recording.calls[1]!.request.messages).toHaveLength(1);
  });

  test("matches ids minted per run by place, and answers with the replay's", async () => {
    const recordedId = crypto.randomUUID();
    const { recording } = await recordCalls(
      [[{ type: "text-delta", delta: `saved ${recordedId}` }, finish()]],
      [{ messages: [user(`record ${recordedId}`)] }],
    );
    const replayId = crypto.randomUUID();
    const replay = RecordingProvider.replay(recording);
    const events = await drain(replay, { messages: [user(`record ${replayId}`)] });
    expect(events[0]).toEqual({ type: "text-delta", delta: `saved ${replayId}` });
  });
});

describe("tolerant matching", () => {
  test("shape: a changed prompt or message text replays stale; exact refuses", async () => {
    const { recording } = await recordCalls(
      [say("ok")],
      [{ systemPrompt: "v1", messages: [user("hi there")] }],
    );
    const replay = RecordingProvider.replay(recording, { match: "shape" });
    await drain(replay, { systemPrompt: "v2", messages: [user("hello there")] });
    expect([...replay.stale].sort()).toEqual(["message text changed", "systemPrompt changed"]);
    expect(replay.staleCalls).toBe(1);

    const longer = RecordingProvider.replay(recording, { match: "shape" });
    await expect(
      drain(longer, { systemPrompt: "v1", messages: [user("hi there"), user("and more")] }),
    ).rejects.toThrow(RecordingMismatchError);

    const exact = RecordingProvider.replay(recording, { match: "exact" });
    await expect(
      drain(exact, { systemPrompt: "v2", messages: [user("hi there")] }),
    ).rejects.toThrow(/differs from the recorded one/);
  });

  test("wording, without fingerprints, refuses a changed prompt", async () => {
    const { recording } = await recordCalls(
      [say("ok")],
      [{ systemPrompt: "v1", messages: [user("hi")] }],
    );
    const replay = RecordingProvider.replay(recording);
    await expect(drain(replay, { systemPrompt: "v2", messages: [user("hi")] })).rejects.toThrow(
      /no fingerprints/,
    );
  });

  test("changed tools replay when the recorded calls still fit, and not when they don't", async () => {
    const before = [tool("save", { title: { type: "string" } })];
    const { recording } = await recordCalls(
      [call("c1", "save", { title: "Home" })],
      [{ messages: [user("save it")], tools: before }],
    );

    const widened = RecordingProvider.replay(recording);
    await drain(widened, {
      messages: [user("save it")],
      tools: [
        tool("save", { title: { type: "string" }, slug: { type: "string" } }),
        tool("delete", {}),
      ],
    });
    expect([...widened.stale]).toEqual(["tools offered changed (+delete)"]);

    const renamed = RecordingProvider.replay(recording);
    await expect(
      drain(renamed, { messages: [user("save it")], tools: [tool("store", {})] }),
    ).rejects.toThrow(/calls save, which is not offered any more/);

    const narrowed = RecordingProvider.replay(recording);
    await expect(
      drain(narrowed, {
        messages: [user("save it")],
        tools: [tool("save", { name: { type: "string" } })],
      }),
    ).rejects.toThrow(/does not fit its schema/);
  });
});

describe("sub-runs, uploads and order", () => {
  test("sub-runs record apart and replay in any interleaving", async () => {
    const live = fakeProvider(say("lead"), say("from a"), say("from b"));
    const recorder = RecordingProvider.record(live as unknown as AgentProvider);
    await drain(recorder, { messages: [user("go")] });
    await drain(recorder.nested("a"), { messages: [user("task a")] });
    await drain(recorder.nested("b"), { messages: [user("task b")] });
    const recording = JSON.parse(JSON.stringify(recorder.recording())) as Recording;
    expect(Object.keys(recording.nested!)).toEqual(["a", "b"]);

    const replay = RecordingProvider.replay(recording);
    const b = await drain(replay.nested("b"), { messages: [user("task b")] });
    const a = await drain(replay.nested("a"), { messages: [user("task a")] });
    expect(a[0]).toEqual({ type: "text-delta", delta: "from a" });
    expect(b[0]).toEqual({ type: "text-delta", delta: "from b" });
    expect(replay.replayedInFull()).toBe(false);
    await drain(replay, { messages: [user("go")] });
    expect(replay.replayedInFull()).toBe(true);
    expect(() => replay.nested("c")).toThrow(/no sub-run "c"/);
  });

  test("ordered replays calls in the order they started", async () => {
    const live = fakeProvider(say("one"), say("two"));
    const recorder = RecordingProvider.record(live as unknown as AgentProvider);
    await drain(recorder.nested("a"), { messages: [user("a")] });
    await drain(recorder.nested("b"), { messages: [user("b")] });
    const replay = RecordingProvider.replay(recorder.recording(), { ordered: true });
    const order: string[] = [];
    await Promise.all([
      drain(replay.nested("b"), { messages: [user("b")] }).then(() => order.push("b")),
      drain(replay.nested("a"), { messages: [user("a")] }).then(() => order.push("a")),
    ]);
    expect(order).toEqual(["a", "b"]);
  });

  test("uploads answer upload_<n>, and the live call is shown the provider's id", async () => {
    const live = fakeProvider(say("seen"));
    const recorder = RecordingProvider.record(live as unknown as AgentProvider);
    const id = await recorder.upload(new File(["x"], "a.png", { type: "image/png" }));
    expect(id).toBe("upload_1");
    const withFile: AgentMessage = {
      ...user("look"),
      content: [{ type: "file", fileId: id, name: "a.png", mimeType: "image/png" }],
    };
    await drain(recorder, { messages: [withFile] });
    expect(live.calls[0]!.messages[0]!.content[0]).toMatchObject({ fileId: "file_1" });

    const replay = RecordingProvider.replay(recorder.recording());
    expect(await replay.upload(new File(["other bytes"], "a.png"))).toBe("upload_1");
    await drain(replay, { messages: [withFile] });
    expect(replay.stale.size).toBe(0);
  });

  test("sub-runs count their own uploads, so they replay uploading in any order (#1236)", async () => {
    const live = fakeProvider(say("from a"), say("from b"));
    const recorder = RecordingProvider.record(live as unknown as AgentProvider);
    const run = async (provider: RecordingProvider, name: string) => {
      const fileId = await provider.upload(new File([name], `${name}.png`, { type: "image/png" }));
      const look: AgentMessage = {
        ...user(`look ${name}`),
        content: [{ type: "file", fileId, name: `${name}.png`, mimeType: "image/png" }],
      };
      return drain(provider, { messages: [look] });
    };
    await run(recorder.nested("a"), "a");
    await run(recorder.nested("b"), "b");
    const recording = JSON.parse(JSON.stringify(recorder.recording())) as Recording;

    const replay = RecordingProvider.replay(recording);
    const b = await run(replay.nested("b"), "b");
    const a = await run(replay.nested("a"), "a");
    expect(a[0]).toEqual({ type: "text-delta", delta: "from a" });
    expect(b[0]).toEqual({ type: "text-delta", delta: "from b" });
    expect(replay.stale.size).toBe(0);
    expect(await replay.nested("b").upload(new File(["c"], "c.png"))).toBe("upload_b_2");
  });

  test("position: a replayed answer waits until the app gets where it was", async () => {
    let head = 0;
    const live = fakeProvider(say("done"));
    const recorder = RecordingProvider.record(live as unknown as AgentProvider, {
      position: () => head,
    });
    head = 3;
    expect(await recorder.pin(2)).toBe(2);
    await drain(recorder, { messages: [user("x")] });
    const recording = recorder.recording();
    expect(recording.calls[0]).toMatchObject({ read: 2, ended: 3 });

    head = 0;
    const replay = RecordingProvider.replay(recording, { position: () => head, waitMs: 2_000 });
    const pinned = replay.pin(5);
    setTimeout(() => (head = 2), 30);
    expect(await pinned).toBe(2);
    let streamed = false;
    const done = drain(replay, { messages: [user("x")] }).then(() => (streamed = true));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(streamed).toBe(false);
    head = 3;
    await done;
  });
});

describe("an agent run", () => {
  test("records a run with tools and replays it to the same result", async () => {
    const save = AgentTool.create({
      name: "save",
      description: "Save a page",
      inputSchema: s.object({ title: s.string() }),
      async execute({ title }) {
        return { saved: title };
      },
    });
    const agentWith = (provider: AgentProvider) =>
      Agent.create({ name: "pages", provider, instructions: "You save pages.", tools: [save] });

    const live = fakeProvider(call("c1", "save", { title: "Home" }), say("Saved Home."));
    const recorder = RecordingProvider.record(live as unknown as AgentProvider);
    const recorded = await agentWith(recorder)
      .stream({ messages: [], turn: { text: "save home" } })
      .result();
    const recording = JSON.parse(JSON.stringify(recorder.recording())) as Recording;

    const replay = RecordingProvider.replay(recording);
    const replayed = await agentWith(replay)
      .stream({ messages: [], turn: { text: "save home" } })
      .result();
    expect(replayed.text).toBe(recorded.text);
    expect(replay.replayedInFull()).toBe(true);
    expect(replay.stale.size).toBe(0);
  });
});

describe("pinClock", () => {
  test("runs Date from the given time, and restores it", () => {
    const realNow = Date.now();
    const restore = pinClock("2026-01-02T03:04:05Z");
    try {
      expect(new Date().toISOString().slice(0, 16)).toBe("2026-01-02T03:04");
      expect(Date.now()).toBeLessThan(realNow);
      expect(new Date(0).getTime()).toBe(0);
    } finally {
      restore();
    }
    expect(Math.abs(Date.now() - realNow)).toBeLessThan(5_000);
  });
});
