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

## Through the MCP registry

A native tool registered with `fromTool` keeps its function:

- **An agent in this server** (`toAgentTools`) gets it as is: the function decides per call, with the run's own context.
- **A remote MCP client** is asked through elicitation only when the function answers `true`. It is called with the call's parsed arguments and a context built by the meta's `remote.context(call)` (a fresh `runId`, `body: {}`). Answered `false`, the call runs without a question, even for a client that cannot elicit. A modern client's retry that carries the user's answer is not decided again.
- **The meta's `requiresApproval: true`** overrides the function: the tool asks every time, and the function is not called. `requiresApproval: false` on a tool with a function is refused at boot, as for `true`.

`McpRegistry.approvalRequired(caller, name, args)` answers the same question for a transport of your own. `execute` holds a remote call to the function's answer unless it is passed `approved: true`.

A route exposed with `fromApiRoute` takes `requiresApproval: true` or `false` only.

## Related

- [MCP Server](./mcp.md): approval by elicitation for remote clients.
- [AI Tools That End the Run](./ai-tool-ends-run.md): `endsRun`, ending the run after a successful call.
- [AI Server Turns](./ai-server-turns.md): answering pending approvals from server code.
- [Mobile Clients](./mobile-clients.md): `approve` on iOS and Android.
