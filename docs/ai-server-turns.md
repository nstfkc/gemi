# AI Server Turns

A chat turn usually starts with a browser request: `useChat` posts to the agent route and reads the stream. `AgentController.startTurn` starts the same turn from server code instead: a queue job, a command, an MCP tool, a webhook. It goes through the same controller, so the agent, the thread's store, `authorizeRequest` and `resource`, `runOwner`, `maxConcurrentRuns`, `instructions()`, `context()`, the hooks and the tools' `ctx` (`threadId`, `ctx.jobs`, `ctx.generate`) all behave as they do for a turn from the chat. The messages are stored on the thread as the run goes, so the chat shows them on its next read.

## Starting a turn

Call it on your controller class:

```typescript
import { Job } from "gemi/services";
import { ChatController } from "@/app/http/controllers/ChatController";

export class ChatEditJob extends Job {
  static name = "ChatEditJob";

  async run(params: { threadId: string; userId: number; siteId: string; message: string }) {
    const user = await loadUser(params.userId); // the user, as your auth middleware would set it
    const turn = await ChatController.startTurn({
      threadId: params.threadId,
      text: params.message,
      user,                              // req.ctx().user for the turn
      body: { siteId: params.siteId },   // what useChat's `body` option would send
    });
    const { text, finishReason, pending } = await turn.result();
    return { runId: turn.runId, text, finishReason, pending: pending.length };
  }
}
```

`startTurn` takes:

| Field | |
|---|---|
| `threadId` | Required. The thread the turn is stored on. It must exist in the controller's `store` (create one with `store.createThread`). |
| `text` | The user's message. Shorthand for `turn: { text }`. |
| `turn` | The whole turn, as `useChat` sends it: `{ text, files, toolResults }`. Leave both `text` and `turn` out to let the model continue the thread. |
| `user` | Who the turn runs as. It is `req.ctx().user` in `authorizeRequest`, `runOwner`, `context()`, the hooks and every tool, and what `Auth.user()` answers there. Absent or `null` is an anonymous turn. |
| `body` | The controller's `Body`, as `useChat`'s `body` option would send it. Typed the same way. |
| `event` | Something that happened, in place of a person's message: `{ name, text?, data? }`. Not with `text` or `turn`. See [Event turns](#event-turns). |
| `ifBusy` | What to do when the thread has a run going: `"supersede"` (the default), `"queue"`, `"join"`, `"parallel"` or `"skip"`. See [A thread that is busy](#a-thread-that-is-busy). |

It answers once the run has started:

- `runId` and `threadId`.
- `run`: the `AgentRun`. Iterate it, or its `frames()`, to follow the turn as it goes.
- `stop({ reason })`: what the chat's stop button does.
- `result()`: settles when the run has ended, its transcript is stored and the controller's hooks have run (or `hookHoldMs` passed). It is the run's `AgentRunResult` (`messages`, `finishReason`, `usage`, `output`, `error`) plus `threadId`, `text` (the text of the run's last assistant message) and `pending`.

## What is the same as a browser turn, and what is not

The turn runs through the controller's `stream`, on a request `startTurn` builds, in a request scope of its own whose user is `user`. So:

- `authorizeRequest` is called with `{ route: "stream", threadId, body }`, and `resource` is checked, against that user.
- `runOwner` names the run's owner from that user (`user:<id>` by default). The user can attach to the run from the chat (in the same process) and stop it, and answer the approvals it raises.
- `maxConcurrentRuns` counts the turn against `runLimitKey`, as for the chat. A turn on a thread whose run is still going supersedes it, as a resend would, unless `ifBusy` says otherwise.
- The route's middleware does not run. The caller is server code and names the user itself. Check what needs checking before calling `startTurn`, or in `authorizeRequest`.
- Called inside another request (an MCP tool route, say), the turn still gets its own scope: it does not read that request's user, and that request is not held open for the run.

## A thread that is busy

By default a server turn on a thread whose run is still going stops that run and starts once its transcript is stored, as a resend from the chat does. That suits a turn that replaces the answer. A turn that reacts to an event (a background job finished, a webhook arrived) usually should not cut off the answer a person is reading, so `ifBusy` picks what happens instead:

| `ifBusy` | On a busy thread |
|---|---|
| `"supersede"` | The default. Stops the running run, then starts. |
| `"queue"` | Waits for the running run to end and its transcript to be stored, then starts, so the model sees that turn's messages. `startTurn` settles once the turn has started. |
| `"join"` | Adds the message to the running turn. The run reads it at its next step. See [Joining the running turn](#joining-the-running-turn). |
| `"parallel"` | Starts a second run beside the running one, with its own `runId` and stream. See [Runs side by side](#runs-side-by-side). |
| `"skip"` | Starts nothing and answers `{ skipped: true, threadId }`. |

```typescript
const turn = await ChatController.startTurn({
  threadId,
  user,
  text: "The export finished.",
  ifBusy: "queue",
});
```

A thread is busy while a run on it is going, or while another turn is setting up on it (for `"skip"`). Queued turns start in the order they were queued, each after the one before it has ended. A queued turn holds nothing while it waits: a person who sends from the chat meanwhile still supersedes the running run, and the queued turn then waits for their turn as well. A stop pressed in the chat stops the running run, and a queued turn starts after it.

With `ifBusy: "skip"`, `startTurn` answers `AgentTurn | AgentTurnSkipped`; check `"skipped" in turn` first. Like the thread's lock, the policy is per process: a run going in another process does not make the thread busy here.

To continue a thread when a background job settles, call `startTurn` with `ifBusy: "queue"` from an [`AgentJobs.onSettled`](./ai-background-jobs.md#continuing-the-thread-when-a-job-settles) listener.

### Joining the running turn

With `ifBusy: "join"` the message becomes part of the turn that is going. The run reads it at its next step: after the model call in flight, or after the tools of that step have run. A run that was about to finish makes one more model call for it. Nothing is stopped and no new run starts.

```typescript
const turn = await ChatController.startTurn({ threadId, user, text: "and make it blue", ifBusy: "join" });
turn.joined;   // true: turn.runId is the running run's id
await turn.result(); // that run's result
```

- The message is stored in the order it arrived, between the run's messages, with `message.turn` (and the older `message.joined`) set to the id of the message that started the turn. It is not a turn start: `splitTurns` puts it with that turn even when runs side by side stored other messages between, `contextWindow` never cuts between them, and a turn's files include the files of the messages that joined it.
- The run sends a `message-id` frame (or a `message` frame for an event) when it takes the message, so a chat that sent it renames its copy there.
- When the run ends before it reaches a step that reads the message (it was on its last step under `maxSteps`, it failed, it was superseded, it parked on an approval), the message starts a turn of its own after the run, as `"queue"` would. That turn goes through the busy rules again, so it can join the run that superseded. A message stored this way is a turn start, without `joined`. From the chat, the reply to it arrives on the same response stream; `startTurn`'s `result()` settles with the run that answered it.
- **A stop drops it.** When a person stops the run (`/stop`, the chat's `stop()`, `AgentTurn.stop()`) before it read the message, no turn starts for it and it is not stored: a stop stops the conversation, messages sent into it included. The joined stream ends with the run, and `startTurn`'s `result()` is the stopped run's (`finishReason: "aborted"`).
- **A refused second try is reported.** If the turn started for the message is refused (`429` from a limit, `403` for another user's run, `409` when `busyPolicy` answers `"skip"`), the message is stored, unanswered, as a turn start. The stream then carries a `message-id` frame renaming the chat's copy to the stored message, and an `error` frame saying it was not answered (`rate_limited` and retryable for a `429`). `startTurn`'s `result()` rejects with the refusal as an `AgentTurnError`.
- A turn with `toolResults` (answering an approval) or with nothing in it is never joined. It waits for the run as `"queue"` would.
- A join adds no run, so it does not count against `maxConcurrentRuns`. Only a run the caller may attach to is joined; another user's run answers `403`.

### Runs side by side

With `ifBusy: "parallel"` a second run starts while the first goes on. Each run has its own `runId`, stream and result.

- Each run reads the thread as it was when it started, plus its own messages: the messages another run is still writing are left out. A parallel turn waits only until the runs already going have stored their opening messages.
- Messages are stored in arrival order. Each run's messages are written by id, so runs writing at once don't overwrite each other.
- Every message a run writes names its turn: `message.turn` is the id of the message that started it (see [Which turn a message belongs to](#which-turn-a-message-belongs-to)). A reply stored after another run's messages still goes with its own question in `splitTurns`, `contextWindow` and compaction.
- Each run counts against `maxConcurrentRuns`. A thread takes at most `maxThreadRuns` runs at once (default `DEFAULT_MAX_THREAD_RUNS`, 3); one more answers `429` with code `too_many_runs`. Override it per thread, and answer `{ max, overflow: "queue" }` to hold the turn until one of the runs ends instead, as `"queue"` waits; it then starts as one more parallel run:

```typescript
protected maxThreadRuns(req: HttpRequest, { threadId, owner, body }) {
  return { max: body.plan === "pro" ? 5 : 2, overflow: "queue" };
}
```

- `stop` with only a `threadId` stops every run on the thread the caller may stop. `attach` with a `runId` attaches to that run; without one, to the newest. `watch` announces each run going on the thread. `useChat`'s `reattach()` resumes the run the chat was following, one run. With `watch: true`, the watch stream announces every run going on the thread each time it connects, and the chat attaches to each.
- `maxThreadRuns` counts every run on the thread, whoever started it. On a thread several users share, one of them can use up its limit; count per owner in `maxThreadRuns` (`owner`, and `this.liveRuns.running({ threadId })` with `this.liveRuns.ownerOf(runId)`) if that matters.
- A parallel run leaves out the answers other runs are still writing, but not their user messages, so the model can see a question that is not answered yet before its own message. It usually answers only its own; say so in the instructions if it should.
- Starting waits until the runs already going have taken their own turns in, for at most five seconds, and outside the thread's lock: a supersede or another turn meanwhile is not held up.

### Which turn a message belongs to

Every message a run writes has `message.turn`: the id of the user message that started the turn it answers. That message has its own id as `turn`.

- A new message (text, files or a server event) starts a turn: its id is the turn's.
- A turn that only answers tool calls (approvals, client tools) carries on the turn that asked them, even when other turns were stored since. So does a turn with nothing in it (a continuation).
- What the run reads while it works is part of its turn: a joined message, a message from its `inbox`, a file a tool showed.
- A message stored before `turn` existed has none. `splitTurns` and `contextWindow` then read it as before: a turn starts at a user message that no tool injected and that joined nothing.

The run's turn is `turn` on the `AgentRun` (`AgentTurn.run` from `startTurn`, or what `agent.stream` returns) and `ctx.turn` in the controller's hooks: `{ id, continues?, answers? }`, where `continues` is set when the request added no message of its own and `answers` lists the `toolCallId`s it answered. It is `undefined` until the run has taken its turn in.

`message.joined` is still written on a joined message, with the same value as `turn`. It is deprecated: read `turn`. It goes in a later minor version.

### Choosing per message: `busyPolicy`

The controller's `busyPolicy` hook decides what happens to each message that arrives on a busy thread, from the chat or from `startTurn`. It is called only when a run is going, and it answers one of the `ifBusy` values. The default answers what the request asked for, `"supersede"` when it asked for nothing.

```typescript
protected busyPolicy(req: HttpRequest, { running, requested, turn, source }: BusyPolicyParams<Body>) {
  if (source === "server") return requested ?? "queue";
  // A short follow-up refines the answer in progress; anything else gets its own run.
  if (turn?.text && turn.text.length < 80) return "join";
  return "parallel";
}
```

Its parameters:

| | |
|---|---|
| `threadId`, `body`, `owner` | The request's thread, `Body` and run owner. |
| `running` | The runs going on the thread, oldest first: `{ runId, startedAt, owner, turn, messageId, body, joined }`, where `turn` is the message that started the run and `joined` the messages that joined it (`{ text?, files?, event? }`), `messageId` the turn's id (`message.turn` on what the run writes; for a run that answers tool calls, the turn that asked them; `undefined` for a moment after the run starts), and `body` the `Body` the request that started it carried. |
| `requested` | What the request asked for (`ifBusy` from `startTurn` or the chat), or `undefined`. |
| `source` | `"client"` or `"server"`. |
| `turn` | The new message. |

`running` holds every run on the thread, other users' included, with their messages' text and files. It is for the server to decide with; don't send it to a client.

An answer that isn't an `ifBusy` value fails the turn. `"skip"` answers a chat request `409` with code `thread_busy`. A regenerate always supersedes and does not ask. Like the other hooks, it can be passed in `defineAgentHooks`.

### From the chat

`useChat` sends `ifBusy` for the whole chat, or per message:

```tsx
const chat = useChat("/chat", { threadId, ifBusy: "parallel" });
chat.sendMessage("and make it blue", { ifBusy: "join" });
```

A client can send `"supersede"`, `"queue"`, `"join"` or `"parallel"` (anything else answers `400`), and only on a thread. Without `ifBusy` a send cuts off the streaming reply, as before. With `"join"`, `"queue"` or `"parallel"` it does not: the chat follows each run on its own stream, each reply is built into its own message and finishes on its own, `status` stays `"streaming"` until the last one ends, `runId` names the oldest run going, and `stop()` stops them all.

## Event turns

A turn that server code starts because something happened (a job finished, an order was paid) isn't a person's message. Storing it as `text` makes the chat show it as something the user said. Pass `event` instead:

```typescript
await ChatController.startTurn({
  threadId,
  user,
  event: { name: "job-settled", text: "The export finished.", data: { jobId } },
  ifBusy: "queue",
});
```

- It is stored as a user message with `message.event` set to `{ name, data }` and `text` as its text, so it is in the thread's history on every later turn.
- The model reads it as `<event name="job-settled">` around the text and the data's JSON, so it can tell it from the person's words.
- A client gets `message.event` typed (`TurnEvent`), on the stream and from a thread read, and can render it as a status line rather than a chat bubble. `DatabaseAgentStore` doesn't use it as the thread's title.
- `name` is letters, digits and `.`, `_`, `:`, `-`, at most 64 characters. `data` must be JSON. Only `startTurn` can write an event: a client posting to the route can't.

## Showing a server turn in an open chat

A chat that is open on the thread doesn't see a turn it didn't start unless it asks. `useChat({ threadId, watch: true })` follows the thread: it keeps a small SSE stream open to `POST /<path>/watch`, which announces each run that starts on the thread (from `startTurn`, another tab, voice), and the hook attaches to it as `reattach()` would. A run announced while the chat is streaming its own is attached at once, beside it.

```tsx
const chat = useChat("/chat", { threadId, initialMessages, watch: true });
```

A server turn's own message (its `text` or `event`) is sent on the run's stream, so the watching chat shows it before the answer. The watch route is mounted by `this.agent()` next to `/attach`. It takes `attach`'s middleware and is authorized as `attach` (`authorizeRequest` with `route: "attach"`), and it only names runs the caller could attach to. Like `attach`, it sees runs in its own process only.

## Refusals

A turn the route would refuse throws an `AgentTurnError` with the status and code it would have answered:

```typescript
import { AgentTurnError } from "gemi/ai";
import { ChatController } from "@/app/http/controllers/ChatController";

try {
  await ChatController.startTurn({ threadId, text, user });
} catch (error) {
  if (error instanceof AgentTurnError && error.code === "too_many_runs") {
    // 429: the user already has `maxConcurrentRuns` conversations answering.
  }
  throw error;
}
```

`status` is the HTTP status (`404` with `thread_not_found`, `429` with `too_many_runs`, `400`, `403`, `413`), `code` the route's code when it has one, and `kind` the refusal's kind (`"permission"`, `"rate_limit"`...). An error thrown by `authorizeRequest` (an `InsufficientPermissionsError`, a policy's refusal) is thrown as it is. `startTurn` without a `threadId` throws a `TypeError`.

## Approvals and questions

A server turn does not answer the calls it raises. A turn that ends `awaiting-input` resolves with `finishReason: "awaiting-input"` and the calls in `pending`, and they stay on the thread, signed for the turn's owner: the assistant message keeps them in `pending`, so a chat opened on the thread later starts with them (see [After a reload](./ai-tool-approvals.md#after-a-reload)). Either the user answers them in the chat like any other approval, or the caller answers with another server turn:

```typescript
const first = await turn.result();
if (first.finishReason === "awaiting-input") {
  await ChatController.startTurn({
    threadId,
    user,
    turn: {
      toolResults: first.pending.map((call) => ({
        toolCallId: call.toolCallId,
        signature: call.signature,
        approve: false,
        reason: "Not approved from the job.",
      })),
    },
  });
}
```

## Where the run lives

A run lives in the process that started it, so a turn started in a `gemi queue:work` worker runs in that worker:

- Await `result()` in the job, so the worker does not move on, or shut down, with the run still going.
- A browser on another process sees the turn through the store (the messages are written as the run goes) rather than through the live stream: `attach` finds runs in its own process only. The thread lock is per process as well, so a browser turn and a server turn on the same thread in two processes are not ordered against each other.
- The run's duration is bounded by the agent's `maxRunDurationMs`, as for a chat turn.
