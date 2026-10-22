# AI Generate

`generate` is one model call with an output schema: no tools, no loop, nothing streamed to a browser. It returns the parsed, typed answer. With `validate`, it also checks the answer against your own rules and asks the model again with the problems until an answer passes.

```ts
import { generate, s } from "gemi/ai";
import { provider } from "@/app/config/ai";

const result = await generate({
  provider,
  instructions: "You are the copywriter of a small bakery's website.",
  prompt: "Write the hero's headline and its button.",
  output: s.object({ headline: s.string(), cta: s.string() }),
});

if (result.ok) console.log(result.output.headline);
else console.error(result.error.code, result.error.message);
```

Inside a tool, call `ctx.generate` instead. It is the same function bound to the turn: it stops when the turn is stopped, and its usage counts toward the turn's.

## The result

`generate` does not throw for a bad answer. It resolves to a result discriminated on `ok`:

- `ok: true` has `output`, the answer typed by the schema (or by `validate`, below).
- `ok: false` has `error` (`code`, `message`, `retryable`, and the provider's `status` and `requestId` when it answered with an error).
- Both have `messages` (the transcript, ending with the model's reply), `usage` (billed whether or not the answer passed), `finishReason`, `attempts` (how many calls were made) and `attemptLog` (each call's outcome, duration and usage).

`error.code` is `invalid_output` when the answer did not match the schema, was cut off at `maxOutputTokens` or never came; `timeout` or `aborted` when `signal` (or `timeoutMs`) stopped it; otherwise the provider's code (`rate_limited`, `content_filtered`, `provider_error`, …).

Pass `throwOnError: true` to get an `AgentRunError` instead of `ok: false`; the return type is then the `ok: true` arm. A failure is logged through `Log.error` unless `logErrors: false`; a stop is not logged.

Options: `provider` and `output` are required, plus `prompt` or `messages` (or both: the prompt is appended as the next user turn). Then `instructions` (the system prompt), `reasoning`, `maxOutputTokens`, `temperature` and `signal`.

## Validation and the repair loop

`validate` gets the parsed answer and says whether it passes. An answer that does not pass is asked again with the problems, up to `attempts` times (3 by default when `validate` is set):

```ts
import { generate, s } from "gemi/ai";
import { provider } from "@/app/config/ai";

const sections = ["Hero", "Menu", "Visit"];

const result = await generate({
  provider,
  instructions: "You plan a website's page.",
  prompt: `Plan these sections, in order: ${sections.join(", ")}.`,
  output: s.object({
    sections: s.array(s.object({ name: s.string(), loud: s.boolean() })),
  }),
  validate: (plan) => [
    plan.sections.map((section) => section.name).join() !== sections.join() &&
      `"sections" must list exactly ${sections.join(", ")}, in order.`,
    plan.sections.filter((section) => section.loud).length !== 1 && "Exactly one section is loud.",
  ],
  attempts: 3,
});

if (result.ok) {
  console.log(result.output.sections, `after ${result.attempts} attempt(s)`);
} else if (result.rejected) {
  console.warn("Never passed:", result.rejected.problems);
}
```

`validate(output, info)` may be async and may have side effects. `info` has `attempt`, `attempts`, `messages` (the transcript ending with this answer) and `signal`. It returns one of:

| Verdict | Means |
|---|---|
| a list of problems | Falsy entries are dropped, so `[cond && "…"]` reads as a checklist. An empty list (or `undefined`) passes, and `output` is the parsed answer. |
| `{ ok: true, value }` | Passes, and `output` is `value`: the answer turned into what you keep. Its type is inferred, so `result.output` is typed as `value`. |
| `{ ok: false, problems, retry? }` | Rejected. `retry` is `"continue"` (the default), `"restart"`, or `false` to stop now (the model declined, and asking again would not change that). |

A throw from `validate` is not a verdict: it rejects the call.

### What the next attempt sends

- **Continue** (a rejection, and a schema mismatch by default): the rejected reply stays in the transcript and the feedback is the next user turn, so the model corrects its own answer instead of starting over.
- **Restart** (an answer cut off at `maxOutputTokens`, an attempt stopped by `attemptTimeoutMs`, and `retry: "restart"`): the reply is dropped and the same request is sent again, with the feedback added to it as a note. Use it for an answer that is no draft to correct: asked to fix a broken one, a model tends to copy it into the same wall. A later restart replaces the note.
- **Again** (a retryable provider error such as a rate limit, unless `retryErrors: false`): the same request is sent unchanged, after the provider's `retryAfter` (at most 30 seconds) when it gave one.

A non-retryable provider error, a stop and the deadline end the loop at once.

`onInvalidOutput` decides what a schema mismatch does: `"continue"` (default) sends the parse error back as a correction, `"restart"` asks again without the reply, `"fail"` ends the loop with the error.

### Feedback

`feedback(problems, info)` writes the text the model gets back. `info.cause` is `"rejected"`, `"invalid_output"`, `"cut_off"` or `"timeout"`, and `info.restart` says whether the text is a note on the same request or a new turn. Without it, gemi sends a short English "Your answer was rejected: - …" message. With [prompt files](./ai-prompts.md):

```ts
feedback: (problems, { cause }) =>
  Prompt.render(cause === "cut_off" ? "builder-cut-off" : "builder-rejected", {
    problems: problems.map((problem) => `- ${problem}`).join("\n"),
  }),
```

### Time limits

- `attemptTimeoutMs` bounds each call. A call still answering after it is stopped and asked again as a cut-off answer is (`cause: "timeout"`), which is the cure for a model that sometimes runs on repeating itself. Validation is not counted.
- `timeoutMs` bounds the whole loop, every call and validation together. When it runs out, the result is `code: "timeout"` and no further attempt is made. It is the same as an `AbortSignal.timeout` passed alongside `signal`.
- `signal` stops everything; `info.signal` in `validate` fires with it.

### When it never passes

When the attempts run out (or `validate` says `retry: false`), the result is `ok: false` with `error.code: "invalid_output"`, the last problems in `error.message`, and `rejected: { output, problems }`: the last answer `validate` rejected, typed by the schema. It is returned rather than thrown, so a caller that would rather keep a flawed answer than none can. With `throwOnError: true` the call rejects with an `AgentRunError` whose `rejected` holds the same.

`rejected` is also kept when a later attempt failed for another reason (a provider error after a rejection).

### Usage and logging

`result.usage` is the sum of every attempt's; each entry of `attemptLog` (also passed to `onAttempt` as it ends) has its own `usage`, `durationMs`, `finishReason`, `outcome` (`passed`, `rejected`, `invalid_output`, `cut_off`, `timeout` or `error`), and the `problems` or `error` it ended with. Under `ctx.generate`, the summed usage is added to the turn's.

```ts
onAttempt: (attempt) => {
  if (attempt.outcome !== "passed") {
    console.warn(`attempt ${attempt.attempt}: ${attempt.outcome} after ${attempt.durationMs} ms`, attempt.problems);
  }
},
```

A loop is logged once, when it ends without a passing answer, not once per attempt.

### Without validate

`attempts` alone retries what gemi can judge by itself: a schema mismatch, a cut-off answer, an attempt timeout and a retryable provider error. Without `validate` or `attempts`, `generate` makes exactly one call, as it always has.
