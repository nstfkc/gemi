// Compiled with `strict: true` by `generate.test.ts`, because that is how an app
// compiles it and the package's own config is not strict — without
// `strictNullChecks`, `undefined` vanishes from every type and `ok` narrows
// nothing, so the claims below cannot be made from a `*.test-d.ts`.
//
// Every line must compile except the ones marked `@ts-expect-error`, and those
// must fail: an unused directive is itself an error, so a narrowing that stopped
// working and one that started letting too much through both show up.
import { generate, OpenAIProvider, s, type AgentError } from "gemi/ai";

const provider = OpenAIProvider.model("gpt-5.4");
const output = s.object({ headline: s.string(), cta: s.string() });

export async function narrowing() {
  const result = await generate({ provider, prompt: "go", output });

  // @ts-expect-error — `output` may be undefined until `ok` is checked
  const unchecked: string = result.output.headline;

  if (result.ok) {
    const headline: string = result.output.headline;
    const none: undefined = result.error;
    return { headline, none, unchecked };
  }
  const error: AgentError = result.error;
  const none: undefined = result.output;
  // Both arms carry the transcript and the bill.
  const retry = await generate({
    provider,
    messages: result.messages,
    prompt: `Your output was rejected: ${error.message}`,
    output,
  });
  const tokens: number = result.usage.totalTokens + retry.usage.totalTokens;
  return { error, none, tokens };
}

export async function destructuring() {
  // The shape the issue writes, without narrowing first.
  const {
    ok,
    output: value,
    error,
    messages,
    usage,
    finishReason,
  } = await generate({
    provider,
    prompt: "go",
    output,
  });
  const maybe: { headline: string; cta: string } | undefined = value;
  const failure: AgentError | undefined = error;
  // @ts-expect-error — not narrowed by a destructured `ok`
  const sure: { headline: string } = value;
  return { ok, maybe, failure, sure, messages, usage, finishReason };
}
