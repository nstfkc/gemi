# AI Tool Approvals

A server tool can ask the user before it runs. The run then ends `awaiting-input` with the call pending, the chat shows it, and the user's `approve(call, true | false)` comes back as the next turn. `requiresApproval` decides when that happens: never (the default), always, or per call.

```ts
import { AgentTool, s } from "gemi/ai";

// Always asks.
export const refundOrder = AgentTool.create({
  name: "refundOrder",
  description: "Refund an order in full",
  inputSchema: s.object({ orderId: s.string() }),
  requiresApproval: true,
  execute: async ({ orderId }) => refunds.create(orderId),
});
```

## Deciding per call

Give `requiresApproval` a function, sync or async, and it decides for each call from the call's input and the run:

```ts
export const drawPictures = AgentTool.create({
  name: "drawPictures",
  description: "Draw pictures for the page (costs credits)",
  inputSchema: s.object({ prompts: s.array(s.string()) }),
  requiresApproval: async (input, ctx) => {
    const settings = await AccountSettings.for(ctx.context.userId);
    return !settings.alwaysAllowPictures;
  },
  execute: async ({ prompts }, ctx) => draw(prompts, ctx),
});
```

- **`false` runs the tool now**, in the same run, like a tool that never asks: no pending call, no second turn, and nothing waits for a browser to be attached. **`true` asks**, exactly as `requiresApproval: true` does.
- **It fails closed.** Only `false` skips the question. A function that throws asks (the error is logged), and so does one that answers anything else, `undefined` included.
- **What it is given.** `input` is the call's parsed input, typed by `inputSchema`; a call whose input fails validation goes back to the model and never reaches the function. `ctx` is a `ToolApprovalContext`: `context` (the run's `AgentContext`), `body` (the app's request body fields, client-controlled as in `ToolContext.body`), `runId`, `threadId`, `toolCallId`, `step`, `depth` and `signal`. Read the user from `context`, not from `body`.
- **When it runs.** After the input is validated and before the call is signed, so an approval still covers exactly the call that was asked about. A `stop()` does not wait for a function that never settles.
- **An answer stands.** Answering a pending call does not call the function again: the user was asked, and their yes or no applies even if the setting changed in between.
- **Each call on its own.** Two calls in one step are decided separately, so one can run while the other waits.
- **Keep it free of side effects.** It may be called more than once for one call (an MCP client's call, below, evaluates it before asking and again when it runs).

A sub-agent's tool works the same way. A call that asks escalates to the parent run like any other pending call (or is refused under `onPending: "deny"`); a call answered `false` runs inside the sub-run.

`tool.requiresApproval` still reads as a boolean: `true` for a function as well, meaning "may ask". The function itself is `tool.approvalPredicate`. Places that only need "may it ask" treat a function as yes: a voice call leaves such a tool out, as it does any tool with `requiresApproval`.

## Showing a preview

`approvalPreview` computes what the user sees before they decide: a dry run, such as the SQL a write would run and how many rows it changes.

```ts
export const executeWrite = AgentTool.create({
  name: "executeWrite",
  description: "Run an UPDATE or DELETE",
  inputSchema: s.object({ sql: s.string() }),
  requiresApproval: true,
  approvalPreview: async ({ sql }, ctx) => {
    const dryRun = await dryRunWrite(sql); // runs it in a transaction and rolls back
    return { sql, affectedRows: dryRun.count, sample: dryRun.rows.slice(0, 20) };
  },
  execute: async ({ sql }, ctx) => runWrite(sql),
});
```

```tsx
// The page: the preview is on the pending call.
{chat.pending.map((call) => (
  <WriteApproval key={call.toolCallId} preview={call.preview} onAnswer={(ok) => chat.approve(call.toolCallId, ok)} />
))}
```

- **When it runs.** Once for each call that goes pending, after the input is validated and `requiresApproval` said to ask, with the same `input` and `ctx` (`ToolApprovalContext`) as a `requiresApproval` function. Not for a call that runs without asking, and not under `onPending: "deny"`.
- **Where it goes.** The value is the pending call's `preview`: on the `awaiting-input` frame, in `useChat`'s `pending`, and in the stored `AgentMessage.pending`, so it is still there after a reload. It is sent and stored as JSON (a `Date` becomes its ISO string). `undefined` means no preview.
- **Display only.** The signature covers the input, not the preview, so approving approves the call. The data can change between the preview and the click: `execute` should re-check what it relies on, for example that the write still changes the number of rows the preview showed.
- **A preview that throws**, or runs past the tool's `timeoutMs`, is logged, and the call is still asked, without `preview`.
- It needs `requiresApproval` (`true` or a function), and is refused on client tools.

## Who approved a call

A call that runs because a person approved it gets `ctx.approval`:

```ts
execute: async ({ sql }, ctx) => {
  // { approved: true, at: "2026-10-28T09:14:03.120Z", by: "user:42", reason?: "..." }
  await AuditLog.create({ sql, approvedBy: ctx.approval?.by, approvedAt: ctx.approval?.at });
  return runWrite(sql);
},
```

- `by` is the run's subject the answer was verified against (`runOwner`, so `user:<id>` by default), `null` for an anonymous run. `at` is when the server accepted the answer. `reason` is what the client sent with the answer, if anything.
- `ctx.approval` is absent for a call that never asked, including one whose `requiresApproval` function answered `false`, so a tool can tell "the user approved this" from "it was allowed to run". It is also absent when an approved tool that escalated a sub-agent's question is re-entered on a later turn.
- The same record is on the call's `ToolResultPart` as `approval`: on the tool's result when it was approved, on the `denied` result (`approved: false`) when it was refused. The stored thread says who decided and when.
- `onToolResult` on the controller sees every tool result, with `approval` on these. See [AI Controller Hooks](./ai-controller-hooks.md). In stateless mode read the record there rather than from what the client posts back.

## Through the MCP registry

A native tool registered with `fromTool` keeps its function:

- **An agent in this server** (`toAgentTools`) gets it as is: the function decides per call, with the run's own context.
- **A remote MCP client** is asked through elicitation only when the function answers `true`. It is called with the call's parsed arguments and a context built by the meta's `remote.context(call)` (a fresh `runId`, `body: {}`). Answered `false`, the call runs without a question, even for a client that cannot elicit. A modern client's retry that carries the user's answer is not decided again.
- **The meta's `requiresApproval: true`** overrides the function: the tool asks every time, and the function is not called. `requiresApproval: false` on a tool with a function is refused at boot, as for `true`.

`McpRegistry.approvalRequired(caller, name, args)` answers the same question for a transport of your own. `execute` holds a remote call to the function's answer unless it is passed `approved: true`.

A route exposed with `fromApiRoute` takes `requiresApproval: true` or `false` only.

## After a reload

The question outlives the page that was watching when it was asked. The assistant message that ended `awaiting-input` keeps the open calls in `pending`, signatures and `path` included, so a page opened later (a reload, a second tab, another instance) can answer them without a live run to attach to.

Hand the thread to `useChat` as usual:

```tsx
// The app's route, server-side.
const initialMessages = await new ChatController().readThread(threadId);

// The page.
const chat = useChat("/chat", { threadId, initialMessages });
// chat.status === "awaiting-input", chat.pending holds the call,
// and chat.approve(call.toolCallId, true) answers it.
```

- `useChat` starts with the calls that are still open in `initialMessages`, and `setMessages` takes them from the messages it is given, so a re-read thread also drops a question another tab answered. `openPending(messages)` (from `gemi/ai/client`) is the same read for code outside the hook.
- A call that has a result since (answered, refused by a later turn, closed as `interrupted`) is not handed back, and the turn that answers or refuses the calls takes them off the message.
- The signatures are bound to the turn's owner (`runOwner`). Anyone else holding the thread sees the question but cannot answer it.
- Two tabs answering the same call: the first wins. The second gets `invalid_tool_result`, its turn runs nothing, and the model is not called again.
- A stateless chat restored from the app's own storage has no stored copy: persist `pending` beside `messages` and `cursor` and pass it as `initialPending`.
- The thread store must keep the whole message, as it already must for `usage` and `outputTruncated`.

## Related

- [MCP Server](./mcp.md): approval by elicitation for remote clients.
- [AI Tools That End the Run](./ai-tool-ends-run.md): `endsRun`, ending the run after a successful call.
- [AI Server Turns](./ai-server-turns.md): answering pending approvals from server code.
- [Mobile Clients](./mobile-clients.md): `approve` on iOS and Android.
