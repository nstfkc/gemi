# AI Providers

An `Agent` (from `gemi/ai`) makes its model calls through a provider. A provider makes one model call and turns the vendor's response stream into gemi's events. It does not run the tool loop, so approvals, `maxSteps`, skills and persistence behave the same whichever provider an agent uses.

## OpenAI and Azure OpenAI

`OpenAIProvider` talks to OpenAI's Responses API, and `AzureOpenAIProvider` talks to the same API on an Azure OpenAI resource. Both take the model name and an optional config. Settings you leave out come from the `ai` config slice and the `OPENAI_*` / `AZURE_OPENAI_*` environment variables.

```typescript
import { Agent, AzureOpenAIProvider, OpenAIProvider } from "gemi/ai";

const openai = OpenAIProvider.model("gpt-5.4");
const azure = AzureOpenAIProvider.model("gpt-5.4", { deployment: "prod-gpt-54" });

export const support = Agent.create({ name: "support", instructions: "Be brief.", provider: openai });
```

`provider.capabilities` says what the model supports (`reasoning`, `structuredOutput`, `fileInput`, `parallelToolCalls`, `toolSearch`). The agent drops anything the provider can't do instead of sending a request the vendor would refuse.

### Retries

A call that fails before the vendor starts answering (a network error, a timeout, a 429 that isn't a spent quota, a 408, 409 or 5xx) is sent again up to `maxRetries` times (default 2), with exponential backoff and jitter starting at 0.5 s. A `Retry-After` header is honoured, capped at 20 s.

A stream that breaks before its first content event is retried the same way: the socket closes while the body is read, the stream ends without a terminal event, or the vendor sends a retryable `response.failed` / `error` event (a server error or a rate limit). These retries also use `maxRetries` and the same backoff. Once a content event (text, reasoning, output or a completed tool call) has been yielded, the call is never retried. A later failure ends it with an error, because the user has already seen part of the answer.

A stream that breaks while it has sent only the arguments of tool calls that never completed is retried too. Those calls never ran, so nothing the model said has been acted on. Their argument deltas were passed on as they arrived (a UI can show a call filling in), so before the retry the provider sends a `tool-call-discard` event naming them. The agent forgets those calls, the stream carries a `tool-call-discard` frame, and `useChat`'s reducer removes their partial parts from the message. The retried answer's calls arrive under new ids. Once the retries are spent, the partial calls stay and the call ends with the error, as before. Aborting the call's signal during a backoff ends it at once with `finish` reason `"aborted"`. Usage reported by a dropped attempt is added to the call's closing `finish` event. `maxRetries: 0` turns both kinds of retry off.

### Watching retries

Each retry is visible outside the provider (#1192). Before the backoff wait, the provider stream carries a `retry` event, and the run turns it into an `onProviderRetry` call on the server and a `retry` frame for the client. Use it to log every attempt with the run's context, or to tell the user the call is being asked again instead of showing an unexplained pause.

```typescript
const run = agent.stream({
  messages,
  turn,
  onProviderRetry: ({ runId, agent, step, attempt, maxRetries, error, status, requestId, delayMs, elapsedMs, phase, timedOut }) => {
    Log.warning("model call retried", { runId, agent, attempt, code: error.code, status, delayMs });
  },
});
```

- `attempt` is the attempt that failed, from 1, and `delayMs` the wait before the next one. `maxRetries` is the provider's. `error` is the normalized error, with the HTTP `status` and `requestId` of the response it came from when there was one. `phase` is `"request"` (no response, or an error status) or `"stream"` (the body broke before its first content event); request attempts are counted per stream attempt. `timedOut` says whether `timeoutMs`, `streamIdleTimeoutMs` or `streamMaxDurationMs` cut it. `elapsedMs` runs from the call's first attempt.
- `runId`, `agent` and `step` (the run's model call, from 1) are added by the run. The hook is handed down to sub-runs started with `ctx.runAgent`, which report their own `runId` and `agent`.
- The hook is not awaited, and one that throws or rejects is logged and ignored, so it cannot slow down or fail the call.
- `AgentController` has the same hook: `onProviderRetry(info, ctx)`, as a method or in `defineAgentHooks`.
- The client gets `{ type: "retry", messageId, attempt, maxRetries, code, delayMs }`: the error's `code` only, never its message, status or request id. A sub-run's retries arrive as `nested-event` frames. The reducer leaves the transcript as it is, and nothing is stored in the thread. `useChat({ onRetry })` is called with the frame's fields for this agent's own retries; a reattach that replays the run's frames calls it again.
- `generate({ onProviderRetry })` takes the same hook, without the run's fields.
- `FallbackProvider` passes a leg's `retry` events on as they happen. A custom `AgentProvider` that retries can yield `{ type: "retry", ...ProviderRetryInfo }` itself.

### Timeouts

These limits bound a call. All of them are set on the provider config:

- **`timeoutMs`** (default 120 000) covers getting the response headers. It stops once the headers arrive.
- **`streamIdleTimeoutMs`** (default 120 000) covers the stream after that: the longest the vendor may send nothing, not even a keepalive. Every chunk resets it, so a long answer that keeps streaming is never cut. When it runs out, the attempt's request is aborted (the connection is released) and the stream fails with a retryable `provider_error` whose message names `streamIdleTimeoutMs`. From there it is handled like any other broken stream: before the first content event it is retried under `maxRetries`, and after it the call ends with that error, without repeating anything the user has seen. `0` turns it off.
- **`streamMaxDurationMs`** (default 300 000) is a wall clock for each attempt's stream, from the response headers to its last event. No chunk resets it, so it also catches a stream that never goes silent, such as a model that keeps streaming the arguments of one tool call for minutes without finishing it. When it runs out, the attempt is aborted and fails with a retryable `provider_error` whose message names `streamMaxDurationMs`, and it is handled like the idle limit. `0` turns it off.
- **`maxToolArgumentChars`** (default `0`, off) is the most argument text one tool call may stream without finishing. Past it the attempt is cut the same way, with a message that names the tool. It is off by default because how large a legitimate call gets depends on your tools. If they normally take a few hundred characters, a call that streams tens of thousands is a runaway, and a cap well above your largest legitimate call catches it in seconds instead of minutes.

```typescript
const azure = AzureOpenAIProvider.model("gpt-5.4", {
  streamIdleTimeoutMs: 45_000,
  streamMaxDurationMs: 90_000,
  maxToolArgumentChars: 20_000,
});
```

The defaults are long on purpose. A reasoning model at a high effort can think for a long while between two events, and a long answer or a large tool call can stream for minutes. A limit that cuts a legitimate call retries (and bills) the same request, which is then cut again, so too short a limit turns a call that used to work into one that always fails. 300 s leaves room for that and is half the agent's default `maxRunDurationMs`, so a run that hits a runaway still has time to ask again. With a low reasoning effort and small tools, where a whole call takes seconds, lower values notice a stall or a runaway much sooner. Aborting the call's signal still ends it at once, as `finish` reason `"aborted"`.

`streamIdleTimeoutMs` does not cover the wait for the response headers; `timeoutMs` does. They are separate on purpose. Some vendors send the headers only once the model starts (Azure does), so that wait includes queueing and prefill, which grows with the prompt and can take tens of seconds on a long thread. Folding it into a short idle limit would cut those slow-but-healthy first responses on every long thread. To bound it, lower `timeoutMs` as well.

A call cut after its output started leaves a message with `finishReason` `"error"` (or `"aborted"` for a stop). On the OpenAI and Azure OpenAI providers, the reasoning such a message holds is not sent back on later turns: the Responses API resolves reasoning by its `rs_…` id, and a response that never completed was never stored. The message's text and tool calls are still sent. If the API still answers `400 Item with id 'rs_…' not found.` for a reasoning item the request sent, the request is sent once more without its reasoning items.

### Prompt cache key

Every request carries a `prompt_cache_key` (#1223). The API routes requests with the same key and the same prompt prefix to the same cache, so the first step of a run can hit the prefix that another run of the same agent just warmed, parallel runs included. Without the key, first steps mostly miss.

By default the key is the agent's name and a 16-digit hash of the call's instructions and tool list (`defaultPromptCacheKey`, exported from `gemi/ai`). Runs that send the same instructions and tools share a key, and agents with different prefixes don't crowd one cache. To set it yourself:

```typescript
Agent.create({ name: "specialist", provider, promptCacheKey: "site-specialists" }); // 1–64 characters
Agent.create({ name: "private", provider, promptCacheKey: false });                 // send none
agent.stream({ messages, promptCacheKey: `tenant-${tenantId}` });                   // per run
```

A shared key only helps when the requests really share a prefix. Keep a key's traffic below what one cache serves (OpenAI suggests about 15 requests a minute per key and prefix), and give busier groups their own keys.

## Anthropic (Claude)

`AnthropicProvider` talks to Anthropic's Messages API (`POST /v1/messages`, API version `2026-10-21`). It takes the model id and the same config as the other providers. The key comes from `apiKey` or `ANTHROPIC_API_KEY` (with no key, `ANTHROPIC_AUTH_TOKEN` is sent as a bearer token), and the host from `baseURL` or `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`; a trailing `/v1` is accepted).

An API key that isn't scoped to a workspace needs the workspace named on every request, or the API answers 400 ("This API key is not scoped to a workspace..."). Set `workspaceId` (or `ANTHROPIC_WORKSPACE_ID`, e.g. `wrkspc_01...`) and it is sent as the `anthropic-workspace-id` header on every call, Messages and Files API alike. Unset, no header is sent. `AzureAnthropicProvider` doesn't send it.

```typescript
import { Agent, AnthropicProvider } from "gemi/ai";

const claude = AnthropicProvider.model("claude-opus-5-5", { streamIdleTimeoutMs: 60_000 });
// With a key that isn't scoped to a workspace:
// AnthropicProvider.model("claude-opus-5-5", { workspaceId: "wrkspc_01..." });

export const support = Agent.create({ name: "support", instructions: "Be brief.", provider: claude });
```

`AnthropicProvider.models()` lists the current ids (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, and older ones). Any other id is sent as written.

Retries, timeouts, `onProviderRetry` and fallback chains work as described above. An `overloaded_error` (HTTP 529, or an `error` event in the stream) and server errors are retried. A 429 is `rate_limited` and honours `retry-after`. A prompt over the context window (`prompt is too long`) is `context_length_exceeded` and is not retried. A refusal (`stop_reason: "refusal"`) ends the call with `content_filtered`. `max_tokens` ends it with reason `"length"`.

How the agent's settings map onto the request:

- **`maxOutputTokens`** is `max_tokens`, which the API requires. Without it, 64 000 is sent.
- **`temperature`** is not sent. On API version `2026-10-21` it is rejected on every model.
- **`toolChoice`**: `"auto"` and `"none"` are sent as they are. `"required"` is `any` and `{ name }` is `tool`, but Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 reject forced tool choice, so on those (and on ids gemi doesn't know) the choice is sent as `auto` and `capabilities.supportsForcedToolChoice` is `false`. The agent then emulates the forced choice with a system line and one more ask (see [`toolChoice` in AI Context Window](./ai-context-window.md)).
- **Tools** are sent flat with `eager_input_streaming`, so their arguments stream as they're written. Tool search is not supported yet (`capabilities.toolSearch` is `false`), so namespaces are flattened and deferred tools are sent whole. `strict` is not sent; the agent validates every call against the tool's schema.
- **`promptCacheKey`** is not sent. Anthropic's cache keys on the prompt prefix itself.
- **History**: a step's tool results are sent in the user turn right after its calls, as the API requires. The assistant's text goes back exactly as written, whitespace-only blocks included, and an `output` part goes back as the text the model wrote (`OutputPart.text`), not a re-serialized value. A history that starts or ends on the assistant gets a fixed user turn there ("(The conversation continues from an earlier point.)", "Continue."), because the API wants a user turn first and refuses a prefill. Another provider's reasoning parts are left out.
- **Cut-off tool calls**: a tool call whose arguments `max_tokens` cut off is discarded (`tool-call-discard`), never run, and the call ends with reason `"length"`.
- **`reasoning`** turns on adaptive thinking (`thinking: {type: "adaptive", display: "summarized"}`) with `output_config.effort` set to the effort (`minimal` is sent as `low`, and `xhigh` as `high` on the 4.6 models). `"none"` turns thinking off where the model has a switch for it (Claude Sonnet 5.5's `between_tools`, at effort `low`); Claude Opus 5.5 and the other 5.x models can't turn thinking off, so there it is effort `low` and the model still thinks. Models that only take a token budget (Claude 4.5 and older) get neither. A forced `toolChoice` works with adaptive thinking, on the models that take one.
- **Thinking round-trip**: thinking streams as reasoning deltas, and each block ends with its `signature` in `ReasoningPart.providerMetadata.anthropic`; redacted thinking is a part with its encrypted `data`. Those parts are sent back unchanged on the next request, empty ones included. The 5.x models think by default, so this happens even without `reasoning`.
- **Preserved thinking**: a thinking block is bound to the conversation that produced it, and a run edits its conversation (`contextWindow` and compaction cut the start, `activeTools` and `prepareStep` change the tools and instructions per step). On Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable/Mythos 5.1 and 5.2, sending a block back after such an edit is a 400 for accounts created from 2026-08-31 (on every account for Mythos 5.1 and the 5.2 models). So every request that sends adaptive thinking sets `thinking.block_binding: {prefix_mismatch_behavior: "drop_block"}` with the `thinking-binding-controls-2026-08-01` beta header: the API drops the blocks an edit invalidated and the step runs without that reasoning. If the API still answers that 400 (and on Foundry, where the binding isn't sent), the provider strips the thinking blocks and asks once more. Keeping instructions and tools the same across steps keeps the reasoning (and the prompt cache).
- **`output`**: a strict schema is sent as `output_config.format` (`json_schema`), transformed the way Anthropic's SDKs do it: constraints the API refuses (`minimum`, `maximum`, `multipleOf`, `minLength`, `maxLength`, `maxItems`, `uniqueItems`, `minItems` above 1, string `format`s outside the supported list, `pattern`s with backreferences, lookaround or `\b`) are moved into the field's `description`, and every object gets `additionalProperties: false`. The agent still validates the answer against the full schema. A schema that isn't strict (one with `s.json()`), or one over the compiler's limits (24 optional or 16 union-typed properties), is asked for in the system prompt instead, and so is a schema the API answers "Schema is too complex for compilation." for (one retry).
- **Prompt caching**: every request marks three `cache_control` breakpoints: the last tool, the system prompt, and the last block of the last message, so each step reads the previous step's prefix from the cache. Prefixes under the model's minimum aren't cached: 512 tokens on Opus 5.5 and 5, Sonnet 5.5, Haiku 5.5 and Fable 5.x, 1024 on Sonnet 5, Opus 4.8 and Sonnet 4.6, up to 4096 on Opus 4.6 and Haiku 4.5.
- **Files**: `upload()` goes through the Files API (`POST /v1/files`). Images (JPEG, PNG, GIF, WebP) are sent as `image` blocks and PDFs and plain text as `document` blocks, by file id. Other types aren't shown to the model; it gets the attachment line and a note that the file couldn't be read.

Usage counts the whole prompt in `inputTokens`, as OpenAI reports it, with `cachedInputTokens` (cache reads) and `cacheWriteInputTokens` (cache writes) as its breakdown. A `ModelPrice` can price cache writes with `cacheWriteInput` (Anthropic charges 1.25x input for the 5-minute cache).

### Claude on Azure AI Foundry

`AzureAnthropicProvider` runs Claude deployed in an Azure AI Foundry resource. Foundry serves the same Messages API under the resource's `/anthropic` path, so everything above applies, with these differences:

- **Endpoint**: `endpoint` (or `baseURL`, or `ANTHROPIC_FOUNDRY_BASE_URL`) is the deployment's Target URI without `/v1/messages`, e.g. `https://acme-ai.services.ai.azure.com/anthropic`. Or give `resourceName` (or `ANTHROPIC_FOUNDRY_RESOURCE`) and the URL is built from it.
- **Auth**: the key goes in the `api-key` header (`apiKey`, or `ANTHROPIC_FOUNDRY_API_KEY`). For Entra ID, pass `getToken`, which is called on every request so an expiring token is refreshed; the token's scope is `https://ai.azure.com/.default`.
- **Deployment**: `deployment` is sent as `model` when the deployment isn't named after the model. Capabilities are still read off the model id.
- **Preserved thinking**: thinking-binding controls are unconfirmed on Foundry, so `block_binding` isn't sent. A thinking block that an edit to the history invalidated is handled by stripping the thinking blocks and asking once more.
- **Missing endpoint**: with no `endpoint`, `baseURL`, `resourceName` or `ANTHROPIC_FOUNDRY_*` variable, the call throws a configuration error naming them.
- **No files**: the Files API returns a 400 on Azure-hosted deployments, so `capabilities.fileInput` is `false` and `upload()` throws. Route uploads to storage (`attachmentDestination` returning `"storage"` on the agent controller) so attachments are kept by gemi and named to the model by attachment id for a tool to read.

```typescript
import { AzureAnthropicProvider } from "gemi/ai";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";

const claude = AzureAnthropicProvider.model("claude-opus-5-5", {
  resourceName: "acme-ai",
  getToken: getBearerTokenProvider(new DefaultAzureCredential(), "https://ai.azure.com/.default"),
});
```

## A provider per run

`agent.stream({ provider })` makes that run's model calls through `provider` instead of the one from `Agent.create`, e.g. to let a user pick a model, route a run to another deployment, or record and replay model calls in a test.

A sub-run started with `ctx.runAgent` inherits it: when the parent run was given a `provider`, the sub-agent's model calls go through it too. When the parent was given none, the sub-agent uses its own. Pass `provider` to `ctx.runAgent` to choose for one sub-run, for example to tell parallel sub-runs apart in a recorder, or to keep a sub-agent on its own model:

```typescript
await ctx.runAgent(researcher, { prompt, provider: recorder.child("researcher") });
await ctx.runAgent(router, { prompt, provider: router.provider });
```

## Fallback chains

`FallbackProvider.chain` wraps an ordered list of providers: the primary first, then the fallbacks. The chain is itself a provider, so you pass it to `Agent.create` like any other provider.

```typescript
import { Agent, AzureOpenAIProvider, FallbackProvider } from "gemi/ai";

const chat = FallbackProvider.chain(
  [
    { provider: AzureOpenAIProvider.model("gpt-5.6-sol", solConfig), timeoutMs: 20_000, reasoning: "low" },
    { provider: AzureOpenAIProvider.model("gpt-5.4", cfg54), timeoutMs: 30_000 },
    { provider: AzureOpenAIProvider.model("gpt-5.6-terra", terraCfg), timeoutMs: 30_000, reasoning: "medium" },
  ],
  {
    fallbackOn: (error, failure) => error.retryable,
    onUsage: ({ index, model, responseModel, attempt, usage, outcome, error }) => {
      console.log({ index, model, responseModel, attempt, usage, outcome, error: error?.code });
    },
  },
);

export const assistant = Agent.create({ name: "assistant", provider: chat });

// The same chain entered at gpt-5.4, for work that should never reach the primary.
const textTasks = chat.from(1);
```

How a call moves through the chain:

- **When it falls back.** A leg that fails before producing output is abandoned and the next leg gets the same request. By default the chain falls back when `error.retryable` is true: a 429 that isn't a spent quota, a 5xx, a 408/409, a timeout or a network failure. Errors that would repeat on any model don't fall back, such as context length or a refused tool schema. `fallbackOn(error, failure)` replaces the default rule. `failure` carries `index`, `model`, `status` and `requestId` (when the failure was an HTTP response) and `timedOut`.
- **No fallback once output has streamed.** Once a leg sends its first text, reasoning, tool-call or structured-output delta, the consumer has it. Any error after that is final and is reported as the call's error. Starting over on another model would put two answers in one message.
- **`timeoutMs` covers the wait for the first content event only.** A leg that has not started answering (text, reasoning, a tool call or structured output) within `timeoutMs` of its start is aborted, and its failure is retryable. A `retry` event is passed on but does not stop or restart the deadline, so a 429 followed by a retry that goes silent still falls back in time. After the first content event, the leg's own `streamIdleTimeoutMs` and `streamMaxDurationMs` apply.
- **`reasoning` per leg.** An entry's `reasoning` overrides the agent's `reasoning` for that leg only.
- **Usage per leg.** `onUsage` is called once for each leg that was tried. The report has its `index`, `model` (the leg's configured model), `responseModel` (the model the vendor says answered, such as the dated snapshot behind `gpt-5.4` or the model behind an Azure deployment name; absent when the leg never got a response), `attempt` (1 for the first leg tried in this call), `usage` (when the leg reported any), `outcome` (`ok`, `fallback`, `failed` or `aborted`) and `error`. Tokens billed by abandoned legs are added to the call's closing usage, so the run's usage is what the call actually cost. If `onUsage` throws, the error is ignored.
- **Which model answered.** The call's closing `finish` event carries `model`, the answering leg's `responseModel`, so code reading the provider stream directly sees it without `onUsage`. The built-in OpenAI and Azure providers set `finish.model` on every call, chain or not.
- **User aborts.** Stopping the run never tries the next leg.
- **Circuit breaking** (opt-in). With `circuit` set, a leg that fails `failures` times in a row (default 3) is skipped for `cooldownMs` (default 30 000), so a dead primary stops costing its `timeoutMs` on every call. Only failures the chain falls back on count. A request any model would refuse doesn't count, and a leg that started answering counts as up even if it failed later. After the cool-down, one call tries the leg again: an answer closes the circuit and a failure reopens it. The last leg is never skipped. A skipped leg isn't reported to `onUsage`, and `attempt` counts only the legs that were tried. `onStateChange` is told when a circuit opens or closes.
- **Capabilities** are the intersection of the legs' capabilities, so a feature one leg lacks is turned off for the whole chain. Without this, a chain could work only while the primary is up.
- **Uploads** go to the first leg only. A provider's file id only works on that provider's account or resource. Legs on the same Azure resource share files. For a chain across accounts, keep provider file ids out of the fallback path or store attachments with gemi.

```typescript
const chat = FallbackProvider.chain(entries, {
  circuit: {
    failures: 3,
    cooldownMs: 30_000,
    onStateChange: ({ model, state }) => log.warn(`${model} circuit ${state}`),
  },
});
```

The circuit state is kept in memory in the process (a `MemoryCircuitStore`). It is shared with the chains that `from()` and `leg()` make from the chain, and not with any other chain. Each instance finds a dead leg on its own, which costs `failures` slow calls per instance per cool-down. To share the state between instances, pass `circuit.store`: any object with `allow(key, policy)` and `record(key, outcome, policy)` (the `CircuitStore` interface). A leg's circuit key is its provider's `model`. Give `circuitKey` to legs that share a model name, such as one model on two Azure resources. A chain whose legs share a key is refused when it is built.

### Comparing the legs: `evalChain`

`evalChain` runs a fixture against every leg on its own, with no fallback between legs, and returns the results per leg. Use it before reordering a chain or switching models.

```typescript
import { Agent, evalChain } from "gemi/ai";

const results = await evalChain(
  chat,
  async (provider) => {
    const run = Agent.create({ name: "eval", provider }).stream({ messages: fixture });
    return (await run.result()).finishReason;
  },
  { samples: 10 },
);
// [{ index: 0, model: "gpt-5.6-sol", results: [...], errors: [...] }, ...]
```

Each leg runs with its own `reasoning` and `timeoutMs`. `chat.leg(i)` returns that single-leg provider if you want to drive it yourself.
