# AI Usage and Cost

gemi meters what AI work costs. Every model call reports itself to the meters open around it: agent steps, `generate`, `ImageModel` generations and edits, and sub-runs, however deep in your code. Each call is priced at its own model's prices. You can also add costs that aren't model calls, like a browser session or an external API, under a label.

An agent run has a meter of its own (`ctx.meter` in its tools, `result.metered` at the end). For work outside a run, open one with `Usage.meter`.

## Prices

Declare what you pay once, at boot. The table form (`ModelPrices`) is USD per million tokens, the same `ModelPrice` that `Eval.create({ pricing })` takes. gemi ships no prices of its own: they change and differ by contract.

```ts
// app/config/ai.ts
import { OpenAIProvider, Usage } from "gemi/ai";

export const provider = OpenAIProvider.model("gpt-5.4");

Usage.configure({
  pricing: {
    "gpt-5.4": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5.4-mini": { input: 0.25, output: 2 },
    "gpt-image-2": { input: 5, cachedInput: 1.25, output: 30, imageInput: 8, imageOutput: 30 },
  },
});
```

- A key also prices the model ids it's a prefix of (`gpt-5.4` prices `gpt-5.4-2026-03-05`), and the longest matching key wins.
- **Set `cachedInput` for every model that reads the prompt cache.** A cache read is a fraction of `input` (Anthropic: a tenth or less, depending on the model), and an agent loop is mostly cache reads. Without it, `usage.costUsd` of a call with cache reads is `null`, and a meter prices them at `input`, an over-count.
- `cacheWriteInput` defaults to `input` times the provider's published rule (`provider.cacheWriteFactor(model)`): 1.25 on Anthropic, for the 5-minute cache gemi asks for. A `FallbackProvider` asks the leg that served the call. Other providers state none: `costUsd` of a call that writes the cache is then `null` unless you set `cacheWriteInput`, and a meter prices writes at `input`. Set `cacheWriteInput` for a contract rate too.
- `imageInput` and `imageOutput` price image tokens; without them, image tokens are priced as text.
- A table can't express long-context tiers, fast modes, regional premiums or batch discounts. Price those with a function, and read the meter's `cost`: a function gives no `costUsd`.
- In a meter, a model with no price costs 0 and is listed in `unpriced`.

Or give a function. It answers the cost in whatever unit you count in, and `undefined` for a model it doesn't price:

```ts
import { Usage } from "gemi/ai";

// USD millionths per token, by model.
const MICROS: Record<string, { input: number; output: number }> = {
  "gpt-5.4": { input: 1.25, output: 10 },
};

Usage.configure({
  pricing: (model, usage) => {
    const price = MICROS[model];
    if (!price) return undefined;
    return Math.round(usage.inputTokens * price.input + usage.outputTokens * price.output);
  },
});
```

If the function throws or answers something that isn't a finite number, the call counts as unpriced rather than failing the model call.

Every cost a meter holds is in the pricing's unit, including the ones you `add`. So with the function above, add micros too.

A meter can override the pricing for itself with `Usage.meter(fn, { pricing })`. A meter without its own pricing uses the nearest enclosing meter's, then `Usage.configure`'s. The configured pricing is read when a call is recorded, so meters that are already open pick up a change.

## `usage.costUsd`

With a table in effect, every model call's usage gets `costUsd` when it finishes, and it's summed with the usage. So `result().usage.costUsd` is the run's cost in USD (its steps, its tools' `generate` calls, sub-runs and images), `generate`'s `result.usage.costUsd` is that call's, and `ImageModel`'s `image.usage.costUsd` that image's.

```ts
const result = await agent.stream(params).result();
await log.insert({ runId: result.runId, costUsd: result.usage.costUsd });
```

- `null` when gemi can't price a call without guessing: its model isn't in the table, or it read the cache and the model has no `cachedInput`, or it wrote the cache with neither `cacheWriteInput` nor a provider rule. A total with such a call in it is `null` too. The first one of each model and reason logs one warning, to the run's log.
- `null` under a pricing function (its unit is yours, not necessarily USD), including a call inside a `Usage.meter(fn, { pricing })` with a function, so a run mixing the two isn't a partial sum. The meter's `cost` covers that case. Absent with no pricing at all.
- A fallback chain prices each leg at its own model: the closing `finish` splits the usage by model (`byModel`) when abandoned legs spent something.
- **Server-side only.** `costUsd` is on `result().usage`, `generate`'s result (its `usage` and its `messages`), `ImageModel`'s results, and `usageLimits.onUsage` (`report.costUsd.delta` / `.total`). An agent run strips it from every frame sent to a client (`usage`, `message-end`, tool calls' generated-image records) and from what it stores (its messages, a sub-run's transcript, compaction summaries), so end users never see what their work cost you.
- **`result().usage` includes it**, and so does `AgentTurn.result()`. Pick the fields you return from a route or an MCP tool rather than returning the result whole. To show spend, send it yourself.
- Video: gemi has no video model. Report what a video API costs with `Usage.add("video", cost)` in the run or meter.

## Metering work outside a run

```ts
import { Usage, generate, s } from "gemi/ai";
import { provider } from "@/app/config/ai";

const BROWSER_SESSION_USD = 0.002;

const { value, cost, byModel, byLabel } = await Usage.meter(async (meter) => {
  const review = await generate({
    provider,
    prompt: "Review this page.",
    output: s.object({ score: s.number() }),
  });
  meter.add("browser", BROWSER_SESSION_USD);
  return review.ok ? review.output.score : null;
});
```

`Usage.meter(fn, options?)` runs `fn` with a meter open and answers `fn`'s value with the totals:

- `usage`: every model call's tokens, summed.
- `cost`: the priced calls plus every added cost.
- `byModel`: `{ usage, cost, count }` per model id (the one the provider reported, or the one it was asked for).
- `byLabel`: `{ usage, cost, count }` per label (see below).
- `unpriced`: the models called that the pricing doesn't price.

Code deep inside `fn` doesn't need the handle. These act on the meters open where they're called:

- `Usage.add(label, cost)` adds a cost to the innermost meter and every meter around it.
- `Usage.record(model, usage)` records a model call gemi didn't make itself (a vendor SDK called directly, a usage report from elsewhere). It's priced like any other call.
- `Usage.current()` is the innermost open meter, or `undefined`.

All three do nothing outside a meter.

## Labels

`add(label, cost)` puts a cost under a label. A meter opened with `{ label }` puts every model call inside it under that label, in its own totals and in every enclosing meter's. The innermost label wins. So "what did the critique cost" is one wrapper, not a counter:

```ts
import { Usage, generate, s } from "gemi/ai";
import { provider } from "@/app/config/ai";

const critique = () =>
  generate({ provider, prompt: "Critique the page.", output: s.object({ ok: s.boolean() }) });

const pass = await Usage.meter(async () => {
  await Usage.meter(critique, { label: "critique" });
  Usage.add("browser", 0.002);
});

pass.byLabel.critique?.cost; // the critique's model calls
pass.byLabel.browser?.cost; // 0.002
pass.cost; // both
```

Calls outside any labelled meter count in `cost`, `usage` and `byModel`, but not in `byLabel`.

## A run's meter

Every agent run opens a meter around itself, nested in whatever meter is open where it starts. A sub-run started with `ctx.runAgent` gets its own meter inside its parent's.

In a tool, `ctx.meter` is the run's meter. `add` counts for this run, the runs above it and any `Usage.meter` the run started in. `totals()` is what the run has spent so far.

```ts
import { AgentTool, s } from "gemi/ai";

const BROWSER_SESSION_USD = 0.002;

export const screenshot = AgentTool.create({
  name: "screenshot",
  description: "Takes a screenshot of the page.",
  inputSchema: s.object({ url: s.string() }),
  outputSchema: s.object({ ok: s.boolean() }),
  execute: async ({ url }, ctx) => {
    // … open a browser session on `url` …
    ctx.meter.add("browser", BROWSER_SESSION_USD);
    return { ok: url !== "" };
  },
});
```

When the run ends, `result.metered` holds its totals: the run's own steps, its tools' `generate`, `generateImage` and `editImage` calls, its sub-runs, and every `ctx.meter.add`, each counted once.

```ts
import { supportAgent } from "@/app/agents/support";

const result = await supportAgent.stream({ messages: [], turn: { text: "Where is my order?" } }).result();

result.metered?.cost; // priced per call
result.metered?.byModel; // the chat model, the image model, a sub-agent's model
```

Unlike `result.usage`, which is one sum across every model the run used, `result.metered` prices each call at its own model's prices. Price a run from `metered`, not from `usage`. `metered` is optional in the type so that results built by hand (stubs, replays) still typecheck, but every agent run sets it.

## Calls that don't end normally

A call is billed when it doesn't finish cleanly too, and its usage is counted (#1353):

- **Cut or broken halfway.** A call cut at the output limit, or a stream that breaks after some output, ends with an `error` and a `finish` that both carry what the provider reported so far. OpenAI reports a cut response's usage (`response.incomplete`, `response.failed`); a stream that just breaks has no count from OpenAI, which reports usage only on its last frame. Anthropic reports usage as the answer streams, so its broken calls are counted.
- **Retried.** An attempt dropped before its first content and asked again is on the `retry` event's `usage`, and added to the `finish` that closes the call, so summing `finish` usage counts it once.
- **Stopped.** A run, `generate()` call or compaction summary stopped mid-call is billed what the call had used, on providers that report usage while they stream: the run's `usage`, the message's `usage` and the meter include it. The Anthropic providers do (their `message_start` already carries the whole input, so a stop before the first token bills it). **OpenAI and Azure OpenAI don't**: the Responses API reports usage only on its last frame, so a stopped OpenAI or Azure call still bills nothing. The provider events say it as `{ type: "usage", usage }` while the call streams: the whole call's count so far, which the closing `finish` replaces. A `FallbackProvider` adds the legs it fell back from, and a stop meters each leg at its own model.

## What a meter doesn't see

- **Work `fn` started and didn't wait for** counts only if it finishes before `fn` returns (or before the run ends, for a run's meter). Once a meter's scope has settled, `add` on it does nothing.
- **Background jobs.** A tool that hands work to `ctx.jobs.start` runs it in a queue worker, outside the run's async context. Open a `Usage.meter` in the job if you want its cost.
- **Compaction summaries made after a run** (in the background, or by a run that was stopped). They're billed to the next run's `usage`, but no meter sees them.
- **Realtime voice.** The voice bridge reports usage through its own `onUsage`. Pass it to `Usage.record` inside a meter if you want it counted.
- **A tool called by a remote MCP client** has no run. Its `ctx.meter` is a meter of its own whose `add`s still reach any `Usage.meter` open around the request.

Concurrent meters don't see each other's calls, and `measureUsage` (tokens only, used by evals) is the same meter without costs.

## Usage limits

A meter tells you what was spent. `usageLimits` stops a run when a budget is spent (#1124). It counts three things:

- `tokens`: the run's `usage.totalTokens`, including its tools' sub-runs, `generate` calls and images;
- `steps`: the run's own model calls;
- `toolCalls`: the tool calls the model made in the run that were executed.

`run` is the run's own budget. `scopes` are budgets shared by every run that names the same key, kept in a `UsageLimitStore`: a user, a tenant, a billing period (put the period in the key). In a controller, `usageLimits()` answers them once per turn, after `context()`:

```ts
export class ChatController extends AgentController<typeof chatAgent> {
  agent = chatAgent;

  protected usageLimits(req, { context }) {
    const month = new Date().toISOString().slice(0, 7);
    return {
      run: { tokens: 200_000, toolCalls: 50 },
      scopes: [{ key: `tenant:${context.tenantId}:${month}`, limit: { tokens: 5_000_000 } }],
      onUsage: async (report) => {
        await UsageRecord.create({ data: { tenantId: context.tenantId, tokens: report.delta.tokens } });
      },
    };
  }
}
```

The same hook is on [`hooks`](./ai-controller-hooks.md) as `usageLimits`. Running the agent yourself, pass `usageLimits` to `agent.stream()`.

How a limit is applied:

- **Checked before what it limits.** `steps` and `tokens` before every model call, `toolCalls` before every tool call. Tokens are only known after a call, so a run stops once it has reached its token limit; the call that crossed it isn't undone.
- **Over a limit,** the run ends with `finishReason: "error"` and the error code `"usage_limit"` (not retryable). The client is told which kind of limit, never a scope's key. `result().error.usageLimit` and the controller's `onError` get `{ scope, metric, limit, used }`, where `scope` is `"run"` or the key. A tool call refused by a limit gets a `usage_limit` result, and the run ends after that step. A scope that's already spent ends the turn before the model is called.
- **`onUsage`** hears what was spent after each model call and each batch of tool calls, and once more as the run ends (`final: true`), with the `delta`, the run's `total` and the scope keys, and `costUsd: { delta, total }` in USD once a call has been priced at a table. A throw is logged and the run goes on.
- **The store.** The default `MemoryUsageLimitStore` counts per process and forgets on restart. Give a shared store when you run more than one instance: an object with `get(key)` and `add(key, delta)`, backed by a database row or Redis. A store whose `get` throws fails the run (code `unknown`, retryable) rather than letting it go on unmetered; an `add` that throws is logged.
- **Concurrency.** Limits are soft under concurrency: two runs of one key can each take their next step before either has added what it spent.
- **Sub-agents.** A sub-run started by `ctx.runAgent` has no limits of its own, but its tokens count toward the parent run's.
