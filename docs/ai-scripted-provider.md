# AI Scripted Provider

An agent test needs a model that answers what the test says, every time. `scriptedProvider`, from `gemi/ai/testing`, answers each model call with the next step of a script: a text reply, tool calls, structured output, an error, or a function of what was sent. Give it one script per agent, by name, and each agent takes its own steps, whatever order the calls come in.

```ts
import { expect, test } from "vitest";
import { Agent, AgentTool, s } from "gemi/ai";
import { scriptedProvider } from "gemi/ai/testing";

test("the planner asks the researcher, then answers", async () => {
  const provider = scriptedProvider({
    planner: [{ toolCalls: [{ name: "research", input: { topic: "tea" } }] }, "Drink green tea in the morning."],
    researcher: ["Green tea has less caffeine than coffee."],
  });

  const researcher = Agent.create({ name: "researcher", provider });
  const research = AgentTool.create({
    name: "research",
    description: "Research a topic",
    inputSchema: s.object({ topic: s.string() }),
    execute: async ({ topic }, ctx) => {
      const run = await ctx.runAgent(researcher, { prompt: topic });
      return run.messages.at(-1)?.content;
    },
  });
  const planner = Agent.create({ name: "planner", provider, tools: [research] });

  const result = await planner.stream({ messages: [], turn: { text: "Plan my mornings" } }).result();

  expect(result.finishReason).toBe("stop");
  expect(provider.callsOf("researcher")[0]?.turn?.text).toBe("tea");
  provider.assertDone();
});
```

`scriptedProvider(steps)` with a plain list answers every call from that one list, whichever agent makes it.

## Steps

| Step | The call answers |
|---|---|
| `"text"` | A text reply. |
| `{ text?, reasoning?, output?, toolCalls?, finishReason?, usage? }` | A reply with any of these. `output` is structured output (an agent with `output`), sent as its JSON. Each tool call is `{ name, input?, id? }`; `id` defaults to `call_<agent>_<call>_<n>`. `finishReason` defaults to `"stop"`, `usage` to one token in and one out. |
| `{ events }` | These `ProviderEvent`s, for anything the shorthand doesn't cover. |
| `{ error }` | A failed call (an `Error`, or a message). The run ends with a `provider_error`. |
| `(call) => step` | The step this function answers, sync or async, from the call (below). |

A tool call's result goes back to the model on the next call, and the agent's next step answers it. Tools run as they would with a live model: their schemas, approvals and errors all apply.

## Calls

`provider.calls` lists every call in the order it was made; `provider.callsOf(name)` lists one agent's. A function step gets the same object:

| | |
|---|---|
| `agent` | The agent's name. `undefined` for a call no agent made (`generateText`, a compaction summary). |
| `depth` | 0 for the run, 1 for a sub-agent it called, and so on. |
| `index` | Which of this agent's calls it is, from 0. |
| `messages` | What the call sent. |
| `turn` | The user turn it answers: `turnOf(messages)`. |
| `params` | The whole `ProviderStreamParams`: `systemPrompt`, `tools`, `toolChoice` and the rest. |

```ts
import { scriptedProvider } from "gemi/ai/testing";

const provider = scriptedProvider([({ turn }) => (turn?.text.includes("refund") ? "Sent to billing." : "How can I help?")]);
```

## The user turn: `turnOf`

`turnOf(messages)` answers the user turn the last message belongs to: `{ message, text, messages }`, where `message` is the user message that started it and `messages` the whole turn. It groups as [`splitTurns`](./ai-context-window.md) does, so a tool's results, the files it showed and a message that joined the turn all stay in it. Read it rather than `messages.at(-1)`, which is a tool result or an assistant step as often as the user's message. It is `undefined` when no user message started the last turn.

Your own fake provider can use it too: it takes the `messages` of `ProviderStreamParams`.

## When the script runs out

A call with no step left fails with a `ScriptedProviderError` naming the agent, the call and its turn (`Agent "planner" made call 3, and its script has 2 step(s) (turn: "Plan my mornings").`). So does a call from an agent the scripts don't name. `scriptedProvider(steps, { exhausted: "stop" })` answers an empty reply instead.

`provider.assertDone()` throws when a step was never taken: a test that expected the agent to call a tool and saw it answer straight away fails there, not later.

## The agent on each call

Every call an agent makes carries `agent: { name, depth }` in `ProviderStreamParams`. A provider of your own can read it the same way. It is not sent to the model, and a [recording](./ai-recordings.md) neither keeps nor matches it.

## Related

- [AI Recordings](./ai-recordings.md): record a live model's calls once and replay them.
- [Testing](./testing.md): what a test process does not do, including real model calls.
