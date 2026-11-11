import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentProvider, ProviderEvent, ProviderStreamParams } from "../AgentProvider";
import { fakeProvider } from "../providers/fakeProvider";
import type { AgentMessage } from "../types";
import { Fingerprints } from "./Fingerprints";
import { type Recording, RecordingMismatchError, RecordingProvider } from "./RecordingProvider";

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const say = (text: string): ProviderEvent[] => [{ type: "text-delta", delta: text }, finish()];
const user = (text: string): AgentMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  content: [{ type: "text", text }],
  createdAt: new Date().toISOString(),
});

async function drain(provider: AgentProvider, params: ProviderStreamParams) {
  for await (const _ of provider.stream(params)) {
    // drained
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A git repository with prompt files, the way an app keeps them. */
function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "gemi-fingerprints-"));
  roots.push(root);
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", ...args], { cwd: root });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  };
  git("init", "-q");
  const write = (next: Record<string, string>) => {
    for (const [path, text] of Object.entries(next)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "prompts");
  };
  write(files);
  return { root, write };
}

/** What `Prompt.render` would make of the two files below, by hand. */
const render = (intro: string, tone: string, business: string) =>
  `${intro.replace("{{business}}", business).replace("{{> tone}}", tone)}`;

describe("Fingerprints", () => {
  const intro =
    "You write the welcome page for {{business}}. Keep it under ninety words.\n{{> tone}}";
  const tone = "Write warmly and plainly, like a neighbour who knows the place.";

  async function recordCase(root: string, business: string) {
    const live = fakeProvider(say("Welcome!"));
    const recorder = RecordingProvider.record(live as unknown as AgentProvider, {
      fingerprints: { root },
    });
    await drain(recorder, {
      systemPrompt: render(intro, tone, business),
      messages: [user("Write it.")],
    });
    return JSON.parse(JSON.stringify(recorder.recording())) as Recording;
  }

  test("a recording names the prompt files and tools it was made with", async () => {
    const { root } = repo({
      "app/agents/welcome/intro.md": intro,
      "app/agents/prompts/tone.md": tone,
      "app/agents/unused.md": "A prompt no request of this case carried, at all.",
    });
    const recording = await recordCase(root, "a bakery");
    expect(Object.keys(recording.fingerprints!.prompts).sort()).toEqual([
      "app/agents/prompts/tone.md",
      "app/agents/welcome/intro.md",
    ]);
    expect(recording.fingerprints!.prompts["app/agents/prompts/tone.md"]).toBe(
      Fingerprints.blob(tone),
    );
    expect(RecordingProvider.changedSince(recording, { root })).toEqual([]);
  });

  test("a reworded prompt replays stale; a changed value is still a mismatch", async () => {
    const { root, write } = repo({
      "app/agents/welcome/intro.md": intro,
      "app/agents/prompts/tone.md": tone,
    });
    const recording = await recordCase(root, "a bakery");

    const reworded = tone.replace("warmly and plainly", "warmly, plainly and briefly");
    write({ "app/agents/prompts/tone.md": reworded });
    expect(RecordingProvider.changedSince(recording, { root })).toEqual([
      "app/agents/prompts/tone.md",
    ]);

    const replay = RecordingProvider.replay(recording, { fingerprints: { root } });
    await drain(replay, {
      systemPrompt: render(intro, reworded, "a bakery"),
      messages: [user("Write it.")],
    });
    expect([...replay.stale]).toEqual(["app/agents/prompts/tone.md changed"]);

    // The value filled into the prompt is not wording: a different business is a different case.
    const other = RecordingProvider.replay(recording, { fingerprints: { root } });
    await expect(
      drain(other, {
        systemPrompt: render(intro, reworded, "a florist"),
        messages: [user("Write it.")],
      }),
    ).rejects.toThrow(RecordingMismatchError);
  });

  test("text moved into a partial counts as wording", async () => {
    const { root, write } = repo({
      "app/agents/welcome/intro.md": intro,
      "app/agents/prompts/tone.md": tone,
    });
    const recording = await recordCase(root, "a bakery");
    const introNow = "You write the welcome page for {{business}}.\n{{> length}}\n{{> tone}}";
    const length = "Keep it under ninety words.";
    write({ "app/agents/welcome/intro.md": introNow, "app/agents/prompts/length.md": length });

    const replay = RecordingProvider.replay(recording, { fingerprints: { root } });
    await drain(replay, {
      systemPrompt: introNow
        .replace("{{business}}", "a bakery")
        .replace("{{> length}}", length)
        .replace("{{> tone}}", tone),
      messages: [user("Write it.")],
    });
    expect([...replay.stale]).toEqual(["app/agents/welcome/intro.md changed"]);
  });

  test("inputs: the app's own hashes, compared today", async () => {
    const { root } = repo({ "app/agents/a.md": "Nothing in this prompt matters here." });
    let schema = "v1";
    const inputs = (tools: ReadonlySet<string>) =>
      tools.has("add_card") ? { Card: Fingerprints.blob(schema) } : {};
    const live = fakeProvider(say("ok"));
    const recorder = RecordingProvider.record(live as unknown as AgentProvider, {
      fingerprints: { root, inputs },
    });
    await drain(recorder, {
      messages: [user("hi")],
      tools: [
        {
          name: "add_card",
          description: "Add a card",
          parameters: { type: "object", properties: {} } as never,
          strict: false,
        },
      ],
    });
    const recording = recorder.recording();
    expect(recording.fingerprints!.tools.add_card).toHaveLength(1);
    expect(RecordingProvider.changedSince(recording, { root, inputs })).toEqual([]);
    schema = "v2";
    expect(RecordingProvider.changedSince(recording, { root, inputs })).toEqual(["input Card"]);
  });

  test("the prompt cache key is neither matched nor fingerprinted (#1231)", async () => {
    const { root, write } = repo({
      "app/agents/welcome/intro.md": intro,
      "app/agents/prompts/tone.md": tone,
    });
    const key = (text: string) => `ck_${Fingerprints.blob(text).slice(0, 12)}`;
    const systemPrompt = render(intro, tone, "a bakery");

    // An old recording: made before requests carried a key.
    const old = await recordCase(root, "a bakery");
    expect(JSON.stringify(old)).not.toContain("promptCacheKey");
    const replayOld = RecordingProvider.replay(old, { fingerprints: { root } });
    await drain(replayOld, {
      systemPrompt,
      promptCacheKey: key(systemPrompt),
      messages: [user("Write it.")],
    });
    expect(replayOld.stale.size).toBe(0);

    // One made by 0.204.0, which kept the key in the request.
    const withKey = structuredClone(old);
    withKey.calls[0]!.request.promptCacheKey = key(systemPrompt);
    const replayKeyed = RecordingProvider.replay(withKey, { fingerprints: { root } });
    await drain(replayKeyed, { systemPrompt, messages: [user("Write it.")] });
    expect(replayKeyed.stale.size).toBe(0);

    // A reworded prompt changes the key with it: still stale, not a mismatch.
    const reworded = tone.replace("warmly and plainly", "warmly, plainly and briefly");
    write({ "app/agents/prompts/tone.md": reworded });
    const rewordedPrompt = render(intro, reworded, "a bakery");
    for (const recording of [old, withKey]) {
      const replay = RecordingProvider.replay(recording, { fingerprints: { root } });
      await drain(replay, {
        systemPrompt: rewordedPrompt,
        promptCacheKey: key(rewordedPrompt),
        messages: [user("Write it.")],
      });
      expect([...replay.stale]).toEqual(["app/agents/prompts/tone.md changed"]);
    }

    // Recording now leaves the key out of the request and the fingerprints.
    const live = fakeProvider(say("Welcome!"));
    const recorder = RecordingProvider.record(live as unknown as AgentProvider, {
      fingerprints: { root },
    });
    await drain(recorder, {
      systemPrompt: rewordedPrompt,
      promptCacheKey: key(rewordedPrompt),
      messages: [user("Write it.")],
    });
    expect(JSON.stringify(recorder.recording())).not.toContain(key(rewordedPrompt));
    expect(live.calls[0]!.promptCacheKey).toBe(key(rewordedPrompt));
  });

  test("a recorded call to a tool with a free-form schema part replays stale (#1234)", async () => {
    const { root, write } = repo({
      "app/agents/welcome/intro.md": intro,
      "app/agents/prompts/tone.md": tone,
    });
    // `props: {}` has no type: `s.fromJSONSchema` can't model it.
    const setProps = (description: string) => ({
      name: "set_props",
      description,
      parameters: {
        type: "object",
        properties: { node: { type: "string" }, props: {} },
        required: ["node", "props"],
        additionalProperties: false,
      } as never,
      strict: false,
    });
    const call: ProviderEvent[] = [
      {
        type: "tool-call",
        toolCallId: "c1",
        name: "set_props",
        args: JSON.stringify({ node: "hero", props: { title: "Hi", columns: 3 } }),
      },
      finish(),
    ];
    const live = fakeProvider(call);
    const recorder = RecordingProvider.record(live as unknown as AgentProvider, {
      fingerprints: { root },
    });
    await drain(recorder, {
      systemPrompt: render(intro, tone, "a bakery"),
      messages: [user("Write it.")],
      tools: [setProps("Set a node's props.")],
    });
    const recording = JSON.parse(JSON.stringify(recorder.recording())) as Recording;

    const reworded = tone.replace("warmly and plainly", "warmly, plainly and briefly");
    write({ "app/agents/prompts/tone.md": reworded });
    const replay = RecordingProvider.replay(recording, { fingerprints: { root } });
    await drain(replay, {
      systemPrompt: render(intro, reworded, "a bakery"),
      messages: [user("Write it.")],
      tools: [setProps("Set the props of a node.")],
    });
    expect([...replay.stale].sort()).toEqual([
      "app/agents/prompts/tone.md changed",
      "tools changed: set_props",
    ]);

    // The tool must still be offered.
    const gone = RecordingProvider.replay(recording, { fingerprints: { root } });
    await expect(
      drain(gone, {
        systemPrompt: render(intro, reworded, "a bakery"),
        messages: [user("Write it.")],
        tools: [{ ...setProps("x"), name: "set_layout" }],
      }),
    ).rejects.toThrow(/not offered any more/);
  });
});
