process.env.SECRET ??= "scripted-provider-test-secret";

import { describe, expect, test } from "vitest";

import { Agent, AgentTool } from "../Agent";
import { s } from "../Schema";
import type { AgentMessage } from "../types";
import { scriptedProvider, ScriptedProviderError, turnOf } from "./index";

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
