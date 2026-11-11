import { describe, expect, test } from "vitest";
import { Agent, AgentTool, defaultPromptCacheKey } from "./Agent";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";

/** #1223: `prompt_cache_key` per agent and per run, with a default. */

const tool = (name: string) =>
  AgentTool.create({ name, description: name, inputSchema: s.object({}), execute: async () => name });

describe("promptCacheKey (#1223)", () => {
  test("by default: the agent's name and a hash of its instructions and tools", async () => {
    const provider = fakeProvider([{ type: "finish", reason: "stop" }], [{ type: "finish", reason: "stop" }]);
    const agent = Agent.create({ name: "site builder", provider, instructions: "Build.", tools: [tool("a")] });
    await agent.stream({ messages: [] }).result();
    await agent.stream({ messages: [] }).result();
    const [first, second] = provider.calls.map((call) => call.promptCacheKey);
    expect(first).toMatch(/^site_builder-[0-9a-f]{16}$/);
    // Two runs with the same prefix share it.
    expect(second).toBe(first);
    expect(first).toBe(defaultPromptCacheKey("site builder", "Build.", provider.calls[0]!.tools!));
  });

  test("a different prefix gets a different key", () => {
    const tools = [{ name: "a", description: "a", parameters: {}, strict: true }];
    const base = defaultPromptCacheKey("x", "one", tools);
    expect(defaultPromptCacheKey("x", "two", tools)).not.toBe(base);
    expect(defaultPromptCacheKey("x", "one", [])).not.toBe(base);
    expect(defaultPromptCacheKey("y", "one", tools)).not.toBe(base);
  });

  test("a string is sent as is, false sends none, and a run overrides the agent", async () => {
    const provider = fakeProvider();
    const fixed = Agent.create({ name: "a", provider, promptCacheKey: "shared-prefix" });
    await fixed.stream({ messages: [] }).result();
    await fixed.stream({ messages: [], promptCacheKey: false }).result();
    const off = Agent.create({ name: "b", provider, promptCacheKey: false });
    await off.stream({ messages: [] }).result();
    await off.stream({ messages: [], promptCacheKey: "run-key" }).result();
    expect(provider.calls.map((call) => call.promptCacheKey)).toEqual([
      "shared-prefix",
      undefined,
      undefined,
      "run-key",
    ]);
  });

  test("a key that is empty or longer than 64 characters throws", () => {
    const provider = fakeProvider();
    expect(() => Agent.create({ name: "a", provider, promptCacheKey: "" })).toThrow(/1 to 64/);
    const agent = Agent.create({ name: "a", provider });
    expect(() => agent.stream({ messages: [], promptCacheKey: "x".repeat(65) })).toThrow(/1 to 64/);
  });
});
