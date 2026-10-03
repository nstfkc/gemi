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
    onUsage: ({ index, model, attempt, usage, outcome, error }) => {
      console.log({ index, model, attempt, usage, outcome, error: error?.code });
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
- **`timeoutMs` covers the first event only.** A leg that sends nothing within `timeoutMs` is aborted, and its failure is retryable. After the first event, the leg's own request timeout applies.
- **`reasoning` per leg.** An entry's `reasoning` overrides the agent's `reasoning` for that leg only.
- **Usage per leg.** `onUsage` is called once for each leg that was tried. The report has its `index`, `model`, `attempt` (1 for the first leg tried in this call), `usage` (when the leg reported any), `outcome` (`ok`, `fallback`, `failed` or `aborted`) and `error`. Tokens billed by abandoned legs are added to the call's closing usage, so the run's usage is what the call actually cost. If `onUsage` throws, the error is ignored.
- **User aborts.** Stopping the run never tries the next leg.
- **Capabilities** are the intersection of the legs' capabilities, so a feature one leg lacks is turned off for the whole chain. Without this, a chain could work only while the primary is up.
- **Uploads** go to the first leg only. A provider's file id only works on that provider's account or resource. Legs on the same Azure resource share files. For a chain across accounts, keep provider file ids out of the fallback path or store attachments with gemi.

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
