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

Calls no agent makes, such as `generate()` or a compaction summary through the run's provider, arrive without a name. In the per-agent form they take the script under `NO_AGENT`:

```ts
import { NO_AGENT, scriptedProvider } from "gemi/ai/testing";

const provider = scriptedProvider({
  writer: ["Here is the draft."],
  [NO_AGENT]: ["The person asked for a draft; it was written."],
});
```

## Steps

| Step | The call answers |
|---|---|
| `"text"` | A text reply. |
| `{ text?, reasoning?, output?, toolCalls?, finishReason?, usage? }` | A reply with any of these. `text` as a list streams each entry as its own delta, for a streaming UI. `output` is structured output (an agent with `output`), sent as its JSON. Each tool call is `{ name, input?, id? }`; `id` defaults to `call_<agent>_<call>_<n>`. Several tool calls in one step run as the model's parallel calls. `finishReason` defaults to `"stop"`, `usage` to one token in and one out; each step's `usage` adds up on the run's result. |
| `{ events }` | These `ProviderEvent`s, for anything the shorthand doesn't cover, such as a `retry` event. |
| `{ error }` | A failed call. An `Error` or a message ends the run with a `provider_error` that is not retryable. `{ code, message, retryable }` fails with exactly that error: a [`FallbackProvider`](./ai-providers.md) moves to its next provider on `retryable: true`, and a client sees the code and `retryable` it would get from a live model. |
| `(call) => step` | The step this function answers, sync or async, from the call (below). |

A tool call's result goes back to the model on the next call, and the agent's next step answers it. Tools run as they would with a live model: their schemas, approvals and errors all apply.

### Sub-agents of the same name, in parallel

A step with two calls to a sub-agent tool starts two runs of the same agent at once. Each takes the next step of that agent's script when it reaches the model, and which one gets there first depends on scheduling. So `researcher: ["about tea", "about coffee"]` can hand the coffee answer to the tea run. Answer from the call instead, with a function step:

```ts
import { scriptedProvider } from "gemi/ai/testing";

const answer = ({ turn }: { turn?: { text: string } }) =>
  turn?.text.includes("tea") ? "Green tea has less caffeine." : "Coffee has more.";

const provider = scriptedProvider({
  planner: [
    { toolCalls: [{ name: "research", input: { topic: "tea" } }, { name: "research", input: { topic: "coffee" } }] },
    "Tea in the morning, coffee after lunch.",
  ],
  researcher: [answer, answer],
});
```

## Calls

`provider.calls` lists every call in the order it was made; `provider.callsOf(name)` lists one agent's. A function step gets the same object:

| | |
|---|---|
| `agent` | The agent's name. `undefined` for a call no agent made (`generate()`, a compaction summary); those take the `NO_AGENT` script. |
| `depth` | 0 for the run, 1 for a sub-agent it called, and so on. |
| `index` | Which of this agent's calls it is, from 0. |
| `messages` | What the call sent. |
| `turn` | The user turn it answers: `turnOf(messages)`. |
| `trailingContext` | The text sent after the conversation ([`trailingContext`](./ai-agent-context.md)), if any. The scripted provider declares `capabilities.trailingContext`, so it is here and not a last message. |
| `params` | The whole `ProviderStreamParams`: `systemPrompt`, `tools`, `toolChoice` and the rest. |

```ts
import { scriptedProvider } from "gemi/ai/testing";

const provider = scriptedProvider([({ turn }) => (turn?.text.includes("refund") ? "Sent to billing." : "How can I help?")]);
```

## The user turn: `turnOf`

`turnOf(messages)` answers the user turn the last message belongs to: `{ message, text, messages }`, where `message` is the user message that started it and `messages` the whole turn. It groups as [`splitTurns`](./ai-context-window.md) does, so a tool's results, the files it showed and a message that joined the turn all stay in it. Read it rather than `messages.at(-1)`, which is a tool result or an assistant step as often as the user's message. It is `undefined` when no user message started the last turn.

Your own fake provider can use it too: it takes the `messages` of `ProviderStreamParams`.

## When the script runs out

A call with no step left fails with a `ScriptedProviderError` naming the agent, the call and its turn (`Agent "planner" made call 3, and its script has 2 step(s) (turn: "Plan my mornings").`). With one list for every call, it names the step and whose call it was (`The script ran out at step 3 (planner's call 2): ...`). `scriptedProvider(steps, { exhausted: "stop" })` answers an empty reply instead.

`exhausted` can also be a step, used for every call past the script. A function step suits a provider shared by a whole test file, where the number of calls isn't known up front:

```ts
const provider = scriptedProvider({ planner: [], writer: [] }, {
  exhausted: (call) => (call.agent === "planner" ? "Here is the plan." : `Draft for: ${call.turn?.text}`),
});
```

`"throw"` and `"stop"` are the modes, so to answer the text "stop", write `{ text: "stop" }`. These calls are in `calls` like any other, and `assertDone()` checks only the scripted steps.

A call from an agent the scripts don't name fails whatever `exhausted` is: a misspelt or renamed agent is never what the test meant.

`provider.assertDone()` throws when a step was never taken: a test that expected the agent to call a tool and saw it answer straight away fails there, not later.

## The agent on each call

Every call an agent makes carries `agent: { name, depth }` in `ProviderStreamParams`. A provider of your own can read it the same way. It is not sent to the model, and a [recording](./ai-recordings.md) neither keeps nor matches it.

## Related

- [AI Recordings](./ai-recordings.md): record a live model's calls once and replay them.
- [Testing](./testing.md): what a test process does not do, including real model calls.
