# AI Context Window

A thread grows with every turn, and every model call sends the history. Without a bound, a long conversation ends when the provider answers `context_length_exceeded`. gemi bounds the request, not the thread: the store keeps every message, and each model call is sent the latest turns that fit.

## `contextWindow`

Set it on the agent, or on the controller to choose per route:

```typescript
import { Agent } from "gemi/ai";

export const assistant = Agent.create({
  name: "assistant",
  provider,
  contextWindow: { maxTurns: 40, maxTokens: 100_000 },
});
```

```typescript
import { AgentController } from "gemi/ai";

class ChatController extends AgentController {
  agent = assistant;
  // Overrides the agent's for this controller's turns. `false` sends everything.
  protected contextWindow = { maxTurns: 40, maxBytes: 400_000 };
}
```

The options (`ContextWindowOptions`):

- `maxTurns`: the most turns sent.
- `maxBytes`: the most characters of message JSON sent. `maxTokens` is the same budget in approximate tokens (four characters each). The system prompt and the tools' schemas are not counted.
- `step` (default 10): how many turns the start of the window moves at a time.
- `note`: text put at the start of the first kept turn when turns were left out. The default is `DEFAULT_CONTEXT_WINDOW_NOTE` ("[Earlier turns of this conversation are not shown.]"). Pass `false` for none, or a function of `{ turns, messages }` left out.

How the cut is made:

- **At a turn start.** A turn is a user message and everything after it up to the next one: the assistant's steps, their tool calls with their results, and any file a tool showed the model (a user-role message that is not a turn). A cut never separates a call from its result.
- **The latest turn is always sent**, even when it alone is over the budget.
- **In steps, for the prompt cache.** Providers cache the request's prefix. A window that slid one turn per turn would change the first message on every turn and miss the cache every time. With `step: 10` the window starts at the thread's 0th, 10th, 20th, … turn, so consecutive turns send the same prefix until the window has to move again. `step: 1` slides one turn at a time.
- **System messages** from before the cut stay at the front.
- **Tool searches are carried.** A call into a `ToolNamespace` (or to a deferred tool) only makes sense after the tool search that loaded it. When that search was in a turn left out, it is put back on the first kept call that needs it, so the request still replays the search before the call.

Only the request changes. `loadThread` still answers the whole thread, `onMessage` and the store still get every message, `readThread` and attach still show all of it, and stateless turns are windowed the same way (`maxHistoryMessages` still refuses an oversized client history). A sub-agent started with `ctx.runAgent` uses its own agent's `contextWindow`.

## `prepareStep`

For anything else, `prepareStep` is called before every model call of a run, with what that call would send, and may answer other messages or instructions for that call alone:

```typescript
import { Agent, windowMessages } from "gemi/ai";

export const assistant = Agent.create({
  name: "assistant",
  provider,
  prepareStep: ({ history, lastStepUsage }) => {
    // Tighter once the last request came close to the model's limit.
    const maxTokens = (lastStepUsage?.inputTokens ?? 0) > 150_000 ? 60_000 : 120_000;
    return { messages: windowMessages(history, { maxTokens }).messages };
  },
});
```

It gets `step` (1, 2, …), `messages` (after `contextWindow`), `history` (before it), `instructions`, the run's `usage`, `lastStepUsage` and `lastFinishReason`, and `runId`, `threadId`, `agent`, `depth`, `context` and `signal`. It answers `{ messages?, instructions? }`, or nothing to send the call unchanged. What it answers is never stored, and the next step starts from the whole history again. If it throws, the run fails with `finishReason: "error"`.

`Agent.stream({ prepareStep })` runs after the agent's own, on what that answered. On a controller, override the method; it gets the turn's hook context too:

```typescript
import { AgentController, type AgentHookContext, type PrepareStepContext } from "gemi/ai";

class ChatController extends AgentController {
  agent = assistant;

  protected prepareStep(step: PrepareStepContext, ctx: AgentHookContext) {
    if (step.step === 1) console.log(`turn on ${ctx.threadId}: ${step.messages.length} messages`);
  }
}
```

Keep it deterministic for the same history, or the provider's prompt cache stops hitting.

## Turns

The helpers the window is built from are exported from `gemi/ai` for an app's own policy:

- `turnStarts(messages)`: the index of each turn's first message (index 0 always starts one).
- `splitTurns(messages)`: the messages grouped into turns.
- `injectedMessageIds(messages)`: the ids of the user-role messages a tool added to show a file, which are not turns.
- `windowMessages(messages, options)`: the policy above, answering `{ messages, start, omittedTurns, omittedMessages }`. It never changes its input.
- `messageSize(message)`: the size `maxBytes` counts.
