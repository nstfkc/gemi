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

## Compaction

With `compact`, the turns the window leaves out are summarised instead of dropped. It is off unless you set it:

```typescript
export const assistant = Agent.create({
  name: "assistant",
  provider,
  contextWindow: {
    maxTurns: 40,
    maxTokens: 100_000,
    compact: { maxSummaryTokens: 1_000 }, // or `compact: true` for the defaults
  },
});
```

The request then becomes `[system messages, summary, ...kept turns]`. The summary is a user message, `COMPACT_SUMMARY_HEADER` followed by the text, and is never stored in the thread.

How it works:

- **Once per cut.** The window's start moves `step` turns at a time, so a summary is made when it moves and reused by every later turn until it moves again. Between moves, consecutive turns send the same prefix, so the provider's prompt cache keeps hitting.
- **Incremental.** The new summary is the previous cut's summary plus the turns that just left the window. A first summary of a long thread is folded in chunks of at most `chunkTokens`, each call building on the last, so the summarised part can be bigger than any context.
- **Stored per thread.** Summaries go to a `SummaryStore`, keyed by thread and cut (the id of the first kept message). An `AgentController` uses its own `AgentStore` when it implements `loadSummaries` and `saveSummary` (`MemoryAgentStore` does, and drops them with the thread). Otherwise they go to `defaultSummaryStore`, in memory. Each record carries a fingerprint of the messages it summarised; if those change (a regenerate, an edit), the record is ignored and a new one is made.
- **No double work.** Concurrent runs on one thread in one process share one summary call per cut. For several processes, implement `lockSummary` on the store (Redis `SET key NX PX ttl`, say): a run that finds a cut locked waits up to `lockWaitMs` for the other process's summary, then sends the plain window.
- **Billed to the run.** Each summary call's usage is added to the run's `usage`.
- **Never fatal.** If the summary call fails, the run sends the plain window with `note`, and doesn't try again on its later steps.
- **Turn boundaries and tool searches** are the window's: the cut is at a turn start, and a tool search a kept namespaced call depends on is carried over (#777). The summary renders tool calls and results as text.
- **Threads only.** It applies to a run with a `threadId`, at the top level. A stateless run or a sub-agent's run gets the plain window.
- **Budget.** `maxSummaryTokens` is reserved from `maxTokens`/`maxBytes`, so the summary and the kept turns together stay within the budget.

The options (`ContextCompactOptions`):

- `provider`: the model that writes the summaries. Default: the run's provider. A cheaper model works well here.
- `instructions`: the summariser's system prompt. Default `DEFAULT_COMPACT_INSTRUCTIONS`; a "keep it under N words" line is appended.
- `maxSummaryTokens` (default 1000): how long a summary may be, in approximate tokens. A longer answer is cut to it.
- `chunkTokens` (default 24000): the most transcript one summary call is sent.
- `reasoning` (default `"low"`): for the summary call.
- `store`: a `SummaryStore` to use instead of the default.
- `lockWaitMs` (default 20000): how long to wait for a summary another process is writing.

A durable store adds `loadSummaries` and `saveSummary` (and optionally `lockSummary`) next to its thread methods, or you pass a separate `SummaryStore` as `compact.store`. A table for it:

```sql
CREATE TABLE agent_thread_summaries (
  thread_id      TEXT NOT NULL,
  cut_message_id TEXT NOT NULL,
  record         JSONB NOT NULL, -- the ThreadSummary
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, cut_message_id)
);
```

```typescript
class DbAgentStore implements AgentStore {
  // ...createThread, loadThread, appendMessages...
  async loadSummaries(threadId: string) {
    const rows = await db.query(
      "SELECT record FROM agent_thread_summaries WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 8",
      [threadId],
    );
    return rows.map((row) => row.record);
  }
  async saveSummary(threadId: string, summary: ThreadSummary) {
    await db.query(
      `INSERT INTO agent_thread_summaries (thread_id, cut_message_id, record) VALUES ($1, $2, $3)
       ON CONFLICT (thread_id, cut_message_id) DO UPDATE SET record = EXCLUDED.record, created_at = now()`,
      [threadId, summary.cutMessageId, summary],
    );
  }
}
```

Keeping the latest few per thread is enough: the latest is what the next cut builds on.

The summary call runs before the first model call of the turn whose window moved, so that turn starts later by one model call (several for a first summary of a long thread).

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
