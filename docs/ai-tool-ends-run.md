# AI Tools That End the Run

After a tool call, a run normally asks the model again, and the model usually writes a line confirming what the tool did. For a tool whose result already is the answer, that extra model call only adds latency. With `endsRun`, a successful call ends the run instead, optionally with a closing text you write from the tool's output.

```ts
import { AgentTool, s } from "gemi/ai";

export const tweakStyle = AgentTool.create({
  name: "tweakStyle",
  description: "Change the CSS of the selected element",
  inputSchema: s.object({ nodeId: s.string(), css: s.string() }),
  execute: async ({ nodeId, css }) => styles.apply(nodeId, css),
  // A string ends the run with that text as the assistant's reply.
  // `null` (or `false`, `undefined`) asks the model again, as without `endsRun`.
  endsRun: (output) => (output.ok ? output.summary : null),
});
```

`endsRun: true` ends the run after every successful call, with no closing text.

## What happens

- **Only a successful call can end the run.** The result must have `status: "ok"`. An error, a timeout, invalid input, a refusal, or a background job that is still `running` goes back to the model as usual, and the function isn't called.
- **The closing text is a new assistant message.** It follows the tool's message, is streamed as `message-start`, one `text-delta` and `message-end`, and is passed to `onMessage` and stored like any reply. It has no `usage`, because no model call produced it. With `true` or `""`, there is no closing message, and the tool's message is the run's last.
- **The run ends with `finishReason: "stop"`**, even on the last step `maxSteps` allows. `result().usage` holds only the model calls the run made, and `onFinish` hooks run as usual.
- **The thread stays valid for the next turn.** The next request replays the tool call, its output, and the closing text as an ordinary assistant message. A text message with no reasoning item before it is valid Responses API input.
- **Calls in the same step.** The run ends only if every call of the step succeeded and asked to end. The closing texts are joined in the order the model made the calls, separated by a blank line. If any call doesn't end the run, the model is asked again as if none had. A call left pending (an approval, a client tool) ends the run `awaiting-input`, as before.
- **Sub-agents.** It ends the run it is in: a tool of a sub-agent started with `ctx.runAgent` ends that sub-run, and the parent's tool gets the result as usual.
- **Calls run in the step loop only.** A call that runs on a later turn (after the user approved it) goes back to the model as before. A client tool (`answeredBy: "client"`) can't set `endsRun`.
- **Structured output.** An agent with an `output` schema that ends this way has no `output`: no model call wrote one.

## The function

`endsRun(output, ctx)` may be async. `output` is the tool's typed result. `ctx` is a `ToolEndsRunContext`: the call's `input`, plus the fields of `ToolApprovalContext` (`context`, `body`, `runId`, `threadId`, `toolCallId`, `step`, `depth` and `signal`).

| Answer | Effect |
|---|---|
| a non-empty string | ends the run, with that string as the closing message |
| `true` or `""` | ends the run, with no closing message |
| `false`, `null` or `undefined` | asks the model again |

A function that throws is logged, and the run continues as if it had answered `null`.

## Related

- [AI Tool Approvals](./ai-tool-approvals.md): `requiresApproval`, the other per-call tool hook.
- [AI Context Window](./ai-context-window.md): `prepareStep`, which changes what the next model call is sent.
