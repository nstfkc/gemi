import { expect, test } from "vitest";
import { Agent, AgentTool, type PrepareStep } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { FallbackProvider } from "./FallbackProvider";
import { capabilitiesForClaude, capabilitiesForModel, claudeRequestFeatures } from "./providers/capabilities";
import { fakeProvider } from "./providers/fakeProvider";
import { buildMessagesRequest } from "./providers/anthropicRequest";
import { s } from "./Schema";
import type { AgentMessage } from "./types";

// #1261: a forced `toolChoice` on a provider that sends it as `auto` is
// emulated with a line and one more ask. The line goes after the
// conversation, with the trailing context (#1345), so the system prompt and
// the cached prefix stay the same on a forced step.

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const text = (delta: string): ProviderEvent[] => [{ type: "text-delta", delta }, finish()];
const callsLookup = (id: string): ProviderEvent[] => [
  { type: "tool-call", toolCallId: id, name: "lookup", args: '{"q":"a"}' },
  finish(),
];

const ran: string[] = [];
const lookup = AgentTool.create({
  name: "lookup",
  description: "Look something up",
  inputSchema: s.object({ q: s.string() }),
  execute: async ({ q }) => {
    ran.push(q);
    return { found: q };
  },
});
const other = AgentTool.create({
  name: "other",
  description: "Something else",
  inputSchema: s.object({}),
  execute: async () => "ok",
});

function setup(
  scripts: ProviderEvent[][],
  options: { forces?: boolean; prepareStep?: PrepareStep; maxSteps?: number } = {},
) {
  ran.length = 0;
  const provider = fakeProvider(...scripts);
  if (options.forces === false) (provider.capabilities as any).supportsForcedToolChoice = false;
  const agent = Agent.create({
    name: "researcher",
    instructions: "You research.",
    provider,
    tools: [lookup, other],
    prepareStep: options.prepareStep ?? (({ step }) => (step === 1 ? { toolChoice: { name: "lookup" } } : {})),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
  });
  return { provider, agent };
}

/** The text a call was sent after the conversation: `trailingContext`, or the fallback message. */
const lineOf = (call: { trailingContext?: string; messages: AgentMessage[] }) => {
  if (call.trailingContext !== undefined) return call.trailingContext;
  const last = call.messages.at(-1);
  return last?.id === "msg_trailing_context" ? (last.content[0] as { text: string }).text : undefined;
};

const texts = (messages: AgentMessage[]) =>
  messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.filter((p) => p.type === "text").map((p: any) => p.text));

test("adds a line naming the tool, after the conversation, when the provider cannot force it", async () => {
  const { provider, agent } = setup([callsLookup("c1"), text("found")], { forces: false });

  await agent.stream({ messages: [], turn: { text: "go" } }).result();

  expect(provider.calls[0]!.toolChoice).toEqual({ name: "lookup" });
  expect(lineOf(provider.calls[0]!)).toContain('"lookup"');
  // The system prompt is the agent's own on every step.
  expect(provider.calls.map((call) => call.systemPrompt)).toEqual(["You research.", "You research."]);
  // Not forced on step 2, so no line there.
  expect(lineOf(provider.calls[1]!)).toBeUndefined();
});

test('"required" asks for a tool call, naming none', async () => {
  const { provider, agent } = setup([callsLookup("c1"), text("found")], {
    forces: false,
    prepareStep: ({ step }) => (step === 1 ? { toolChoice: "required" } : {}),
  });

  await agent.stream({ messages: [], turn: { text: "go" } }).result();

  const line = lineOf(provider.calls[0]!)!;
  expect(line).toMatch(/tool/);
  expect(line).not.toContain('"lookup"');
});

test("a step that ends without the call is asked again once, with the line", async () => {
  const { provider, agent } = setup([text("I will look it up."), callsLookup("c1"), text("found")], {
    forces: false,
  });

  const result = await agent.stream({ messages: [], turn: { text: "go" } }).result();

  expect(provider.calls).toHaveLength(3);
  expect(provider.calls[1]!.toolChoice).toEqual({ name: "lookup" });
  expect(lineOf(provider.calls[1]!)).toContain('"lookup"');
  expect(ran).toEqual(["a"]);
  expect(result.finishReason).toBe("stop");
  expect(texts(result.messages)).toEqual(["I will look it up.", "found"]);
});

test("asked again only once: a second answer without the call ends the run as before", async () => {
  const { provider, agent } = setup([text("first"), text("second"), text("never")], { forces: false });

  const result = await agent.stream({ messages: [], turn: { text: "go" } }).result();

  expect(provider.calls).toHaveLength(2);
  expect(result.finishReason).toBe("stop");
  expect(texts(result.messages)).toEqual(["first", "second"]);
});

test("not asked again on the last step", async () => {
  const { provider, agent } = setup([text("first"), text("second")], { forces: false, maxSteps: 1 });

  await agent.stream({ messages: [], turn: { text: "go" } }).result();

  expect(provider.calls).toHaveLength(1);
});

test("a provider that forces it gets no line and no second ask", async () => {
  const { provider, agent } = setup([text("first"), text("second")]);

  const result = await agent.stream({ messages: [], turn: { text: "go" } }).result();

  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0]!.systemPrompt).toBe("You research.");
  expect(lineOf(provider.calls[0]!)).toBeUndefined();
  expect(texts(result.messages)).toEqual(["first"]);
});

test("the capability flag: Claude models without forced choice, OpenAI with it", () => {
  expect(capabilitiesForClaude("claude-opus-5-5").supportsForcedToolChoice).toBe(false);
  expect(capabilitiesForClaude("claude-sonnet-4-6").supportsForcedToolChoice).toBe(true);
  expect(capabilitiesForModel("gpt-5.4").supportsForcedToolChoice).toBe(true);
});

test("a fallback chain forces only when every leg does", () => {
  const forcing = fakeProvider();
  const notForcing = fakeProvider();
  (notForcing.capabilities as any).supportsForcedToolChoice = false;
  expect(new FallbackProvider([{ provider: forcing }, { provider: forcing }]).capabilities.supportsForcedToolChoice).toBe(true);
  expect(new FallbackProvider([{ provider: forcing }, { provider: notForcing }]).capabilities.supportsForcedToolChoice).toBe(false);
});

test("on a provider that places the trailing text itself, the line joins it there, and the system prompt stays", async () => {
  const { provider, agent } = setup([text("I will look it up."), callsLookup("c1"), text("found")], { forces: false });
  (provider.capabilities as any).trailingContext = true;
  await agent.stream({ messages: [], turn: { text: "go" }, trailingContext: "Note." }).result();
  expect(provider.calls[0]!.trailingContext).toMatch(/^Note\.\n\n.*"lookup"/s);
  expect(provider.calls.map((call) => call.systemPrompt)).toEqual(["You research.", "You research.", "You research."]);
  // The second ask: the history ends on the assistant's text, and the last message sent is the user's line.
  const second = provider.calls[1]!;
  expect(second.messages.at(-1)!.role).toBe("assistant");
  const body = buildMessagesRequest(second as any, {
    model: "claude-opus-5-5",
    modelId: "claude-opus-5-5",
    capabilities: { ...capabilitiesForClaude("claude-opus-5-5"), ...claudeRequestFeatures() },
    forcedToolChoice: false,
    blockBinding: true,
  });
  const last = body.messages.at(-1)!;
  expect(last.role).toBe("user");
  expect(JSON.stringify(last.content)).toContain('\\"lookup\\"');
});
