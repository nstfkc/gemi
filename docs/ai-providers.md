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
- **`timeoutMs` covers the first event only.** A leg that sends nothing within `timeoutMs` is aborted, and its failure is retryable. After the first event, the leg's own `streamIdleTimeoutMs` and `streamMaxDurationMs` apply.
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
