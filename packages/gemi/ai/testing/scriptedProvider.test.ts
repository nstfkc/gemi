process.env.SECRET ??= "scripted-provider-test-secret";

import { describe, expect, test } from "vitest";

import { Agent, AgentTool } from "../Agent";
import { FallbackProvider } from "../FallbackProvider";
import { generate } from "../generate";
import { s } from "../Schema";
import type { AgentMessage } from "../types";
import { NO_AGENT, scriptedProvider, ScriptedProviderError, turnOf } from "./index";

const msg = (id: string, role: AgentMessage["role"], text: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  id,
  role,
  content: [{ type: "text", text }],
  createdAt: new Date(0).toISOString(),
  finishReason: "stop",
  ...extra,
});

/** The text of the run's last message. */
const lastText = (result: { messages: AgentMessage[] }) =>
  result.messages
    .at(-1)!
    .content.map((part) => (part.type === "text" ? part.text : ""))
    .join("");

describe("scriptedProvider (#1343)", () => {
  test("one list answers every call in order, with text and tool calls", async () => {
    const seen: unknown[] = [];
    const provider = scriptedProvider([{ toolCalls: [{ name: "add", input: { a: 2, b: 3 } }] }, "It is 5."]);
    const agent = Agent.create({
      name: "calculator",
      provider,
      tools: [
        AgentTool.create({
          name: "add",
          description: "Add",
          inputSchema: s.object({ a: s.number(), b: s.number() }),
          execute: async (input: { a: number; b: number }) => {
            seen.push(input);
            return input.a + input.b;
          },
        }),
      ],
    });
    const result = await agent.stream({ messages: [], turn: { text: "2 + 3?" } }).result();
    expect(lastText(result)).toBe("It is 5.");
    expect(seen).toEqual([{ a: 2, b: 3 }]);
    expect(provider.calls.map((call) => [call.agent, call.index, call.turn?.text])).toEqual([
      ["calculator", 0, "2 + 3?"],
      ["calculator", 1, "2 + 3?"],
    ]);
    provider.assertDone();
  });

  test("scripts by agent name: a sub-agent takes its own steps, whatever order the calls come in", async () => {
    const provider = scriptedProvider({
      planner: [{ toolCalls: [{ name: "researcher", input: { prompt: "tea" } }] }, "Plan: drink green tea."],
      researcher: ["Green tea has less caffeine."],
    });
    const researcher = Agent.create({ name: "researcher", provider });
    const research = AgentTool.create({
      name: "researcher",
      description: "Research a topic",
      inputSchema: s.object({ prompt: s.string() }),
      execute: async ({ prompt }: { prompt: string }, ctx) => {
        const nested = await ctx.runAgent(researcher, { prompt });
        return lastText(nested);
      },
    });
    const planner = Agent.create({ name: "planner", provider, tools: [research] });

    const result = await planner.stream({ messages: [], turn: { text: "plan my mornings" } }).result();
    expect(lastText(result)).toBe("Plan: drink green tea.");
    expect(provider.callsOf("researcher")).toHaveLength(1);
    expect(provider.callsOf("researcher")[0]!.depth).toBe(1);
    expect(provider.callsOf("planner").map((call) => call.depth)).toEqual([0, 0]);
    provider.assertDone();
  });

  test("a function step answers from what was sent", async () => {
    const provider = scriptedProvider([({ turn }) => `You said: ${turn?.text}`]);
    const agent = Agent.create({ name: "echo", provider });
    expect(lastText(await agent.stream({ messages: [], turn: { text: "hello" } }).result())).toBe("You said: hello");
  });

  test("structured output is sent as JSON", async () => {
    const provider = scriptedProvider([{ output: { mood: "calm" } }]);
    const agent = Agent.create({ name: "mood", provider, output: s.object({ mood: s.string() }) });
    const result = await agent.stream({ messages: [], turn: { text: "how is it" } }).result();
    expect(result.output).toEqual({ mood: "calm" });
  });

  test("a call past its script fails the run with a message naming the agent, the call and the turn", async () => {
    const provider = scriptedProvider({ greeter: ["Hi."] });
    const agent = Agent.create({ name: "greeter", provider });
    await agent.stream({ messages: [], turn: { text: "hello" } }).result();
    const second = await agent.stream({ messages: [], turn: { text: "again" } }).result();
    expect(second.finishReason).toBe("error");
    expect(second.error?.message).toBe('Agent "greeter" made call 2, and its script has 1 step(s) (turn: "again").');

    const stranger = await Agent.create({ name: "stranger", provider }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(stranger.error?.message).toMatch(/Agent "stranger" has no script .* The scripts are for "greeter"\./);
  });

  test('exhausted: "stop" answers an empty reply instead', async () => {
    const provider = scriptedProvider([], { exhausted: "stop" });
    const result = await Agent.create({ name: "quiet", provider }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(result.finishReason).toBe("stop");
  });

  test('exhausted: "stop" still fails a call from an agent the scripts do not name', async () => {
    const provider = scriptedProvider({ greeter: [] }, { exhausted: "stop" });
    expect((await Agent.create({ name: "greeter", provider }).stream({ messages: [], turn: { text: "x" } }).result()).finishReason).toBe("stop");
    const typo = await Agent.create({ name: "greter", provider }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(typo.finishReason).toBe("error");
    expect(typo.error?.message).toMatch(/Agent "greter" has no script/);
  });

  test("exhausted: a step answers every call past the script, from the call", async () => {
    const provider = scriptedProvider(["First."], {
      exhausted: (call) => `${call.agent} call ${call.index + 1}: ${call.turn?.text}`,
    });
    const agent = Agent.create({ name: "echo", provider });
    const texts: string[] = [];
    for (const text of ["a", "b", "c"]) {
      texts.push(lastText(await agent.stream({ messages: [], turn: { text } }).result()));
    }
    expect(texts).toEqual(["First.", "echo call 2: b", "echo call 3: c"]);
    expect(provider.calls).toHaveLength(3);
    expect(() => provider.assertDone()).not.toThrow();
  });

  test("exhausted: a step is per agent too, and an agent the scripts do not name still fails", async () => {
    const provider = scriptedProvider({ main: [], builder: ["Built."] }, { exhausted: { text: "stop" } });
    const main = await Agent.create({ name: "main", provider }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(lastText(main)).toBe("stop");
    const builder = Agent.create({ name: "builder", provider });
    expect(lastText(await builder.stream({ messages: [], turn: { text: "x" } }).result())).toBe("Built.");
    expect(lastText(await builder.stream({ messages: [], turn: { text: "y" } }).result())).toBe("stop");
    const typo = await Agent.create({ name: "biulder", provider }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(typo.finishReason).toBe("error");
    expect(typo.error?.message).toMatch(/Agent "biulder" has no script/);
  });

  test("exhausted: a step leaves assertDone checking the scripted steps", async () => {
    const provider = scriptedProvider({ main: ["One.", "Two."] }, { exhausted: { text: "More." } });
    await Agent.create({ name: "main", provider }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(() => provider.assertDone()).toThrow('Steps never used: "main": 1 step(s).');
  });

  test("one list running out says which step, and whose call it was", async () => {
    const provider = scriptedProvider(["Hi."]);
    await Agent.create({ name: "a", provider }).stream({ messages: [], turn: { text: "x" } }).result();
    const result = await Agent.create({ name: "b", provider }).stream({ messages: [], turn: { text: "y" } }).result();
    expect(result.error?.message).toBe('The script ran out at step 2 (b\'s call 1): it has 1 step(s) (turn: "y").');
  });

  test("one step with two tool calls runs both, with distinct ids", async () => {
    const ran: string[] = [];
    const provider = scriptedProvider([
      { toolCalls: [{ name: "note", input: { text: "one" } }, { name: "note", input: { text: "two" } }] },
      "Noted both.",
    ]);
    const note = AgentTool.create({
      name: "note",
      description: "Note",
      inputSchema: s.object({ text: s.string() }),
      execute: async ({ text }: { text: string }) => {
        ran.push(text);
        return "ok";
      },
    });
    const result = await Agent.create({ name: "notes", provider, tools: [note] }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(ran.sort()).toEqual(["one", "two"]);
    const ids = result.messages.flatMap((message) => message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : [])));
    expect(ids).toEqual(["call_notes_0_0", "call_notes_0_1"]);
    expect(lastText(result)).toBe("Noted both.");
  });

  test("a step's usage reaches the result, summed over the run", async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ name: "noop" }], usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { text: "Done.", usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 } },
    ]);
    const noop = AgentTool.create({ name: "noop", description: "Nothing", inputSchema: s.object({}), execute: async () => "ok" });
    const result = await Agent.create({ name: "u", provider, tools: [noop] }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 5, totalTokens: 35 });
  });

  test("a sub-agent's sub-agent is at depth 2", async () => {
    const provider = scriptedProvider({
      top: [{ toolCalls: [{ name: "ask", input: { prompt: "a" } }] }, "top done"],
      middle: [{ toolCalls: [{ name: "ask", input: { prompt: "b" } }] }, "middle done"],
      bottom: ["bottom done"],
    });
    const asking = (next: Agent<any>) =>
      AgentTool.create({
        name: "ask",
        description: "Ask",
        inputSchema: s.object({ prompt: s.string() }),
        execute: async ({ prompt }: { prompt: string }, ctx) => lastText(await ctx.runAgent(next, { prompt })),
      });
    const bottom = Agent.create({ name: "bottom", provider });
    const middle = Agent.create({ name: "middle", provider, tools: [asking(bottom)] });
    const top = Agent.create({ name: "top", provider, tools: [asking(middle)] });
    await top.stream({ messages: [], turn: { text: "go" } }).result();
    expect(provider.calls.map((call) => [call.agent, call.depth])).toEqual([
      ["top", 0],
      ["middle", 1],
      ["bottom", 2],
      ["middle", 1],
      ["top", 0],
    ]);
    provider.assertDone();
  });

  test("a text list streams one delta per entry", async () => {
    const provider = scriptedProvider([{ text: ["Hel", "lo"] }]);
    const deltas: string[] = [];
    const stream = Agent.create({ name: "t", provider }).stream({ messages: [], turn: { text: "x" } });
    for await (const event of stream) if (event.type === "text-delta") deltas.push(event.delta);
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  test("calls no agent makes take the NO_AGENT script", async () => {
    const provider = scriptedProvider({ writer: [], [NO_AGENT]: [{ output: { title: "Tea" } }] });
    const result = await generate({ provider, output: s.object({ title: s.string() }), prompt: "name it" });
    expect(result.ok && result.output).toEqual({ title: "Tea" });
    expect(provider.calls[0]!.agent).toBeUndefined();
    provider.assertDone();

    const unscripted = await generate({ provider: scriptedProvider({ writer: [] }), output: s.object({}), prompt: "x" });
    expect(unscripted.ok).toBe(false);
    expect(unscripted.error?.message).toMatch(/A call no agent made has no script.*Script it under \[NO_AGENT\]\./);
  });

  test("an error step can be retryable, so a FallbackProvider moves on", async () => {
    const down = scriptedProvider([{ error: { code: "overloaded", message: "busy", retryable: true } }]);
    const up = scriptedProvider(["From the backup."]);
    const provider = new FallbackProvider([{ provider: down }, { provider: up }]);
    const result = await Agent.create({ name: "f", provider }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(lastText(result)).toBe("From the backup.");
    expect(down.normalizeError(new ScriptedProviderError("busy", { code: "overloaded", message: "busy", retryable: true }))).toEqual({
      code: "overloaded",
      message: "busy",
      retryable: true,
    });

    const final = scriptedProvider([{ error: { code: "overloaded", message: "busy", retryable: true } }]);
    const failed = await Agent.create({ name: "g", provider: final }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(failed.error).toMatchObject({ code: "overloaded", retryable: true });
  });

  test("an error step fails the call", async () => {
    const provider = scriptedProvider([{ error: "the model is down" }]);
    const result = await Agent.create({ name: "a", provider }).stream({ messages: [], turn: { text: "x" } }).result();
    expect(result.finishReason).toBe("error");
    expect(result.error?.message).toBe("the model is down");
  });

  test("assertDone names the steps never taken", () => {
    const provider = scriptedProvider({ a: ["one"], b: ["one", "two"] });
    expect(() => provider.assertDone()).toThrow(ScriptedProviderError);
    expect(() => provider.assertDone()).toThrow('"a": 1 step(s), "b": 2 step(s)');
  });
});

describe("turnOf (#1343)", () => {
  test("is the last turn's user message, however its steps are laid out", () => {
    const messages = [
      msg("u0", "user", "first"),
      msg("a0", "assistant", "one"),
      msg("u1", "user", "second"),
      msg("a1", "assistant", "calling a tool"),
      msg("a2", "assistant", "after the tool"),
    ];
    const turn = turnOf(messages)!;
    expect(turn.text).toBe("second");
    expect(turn.message.id).toBe("u1");
    expect(turn.messages.map((message) => message.id)).toEqual(["u1", "a1", "a2"]);
  });

  test("a message that joined a turn does not start one", () => {
    const messages = [
      msg("u0", "user", "write the hero"),
      msg("j0", "user", "make it blue", { joined: "u0" }),
    ];
    expect(turnOf(messages)?.text).toBe("write the hero");
  });

  test("is undefined with no user message", () => {
    expect(turnOf([])).toBeUndefined();
    expect(turnOf([msg("a0", "assistant", "hello")])).toBeUndefined();
  });
});
