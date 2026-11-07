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
| `ifBusy` | What to do when the thread has a run going: `"supersede"` (the default), `"queue"` or `"skip"`. See [A thread that is busy](#a-thread-that-is-busy). |

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
