import type { AgentProvider, ProviderEvent, ProviderStreamParams } from "../AgentProvider";

/**
 * Scripted `ProviderEvent`s, one script per model call.
 *
 * The real provider is written against the same interface elsewhere; depending
 * on it in a test would make that test a test of two things at once, and would
 * need a network.
 *
 * It lives in source rather than in a test file for the same reason
 * `store/stubAgentRun.ts` does: both the `Agent` tests and the controller tests
 * need it, and a test file that imports another test file gets that file's
 * suites collected twice.
 */
export class FakeProvider {
  readonly model = "fake";
  readonly capabilities = {
    reasoning: true,
    structuredOutput: true,
    fileInput: true,
    parallelToolCalls: true,
    toolSearch: true,
  };
  readonly calls: ProviderStreamParams[] = [];

  constructor(private scripts: ProviderEvent[][]) {}

  stream(params: ProviderStreamParams) {
    this.calls.push(params);
    const script = this.scripts[this.calls.length - 1] ?? [
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ];
    return (async function* () {
      for (const event of script) yield event;
    })();
  }

  /**
   * Every upload, and a distinct id for each.
   *
   * Recorded rather than counted because the interesting assertion is a
   * negative one: a tool that escalates is re-entered from the top, and the
   * test that matters says the second entry uploaded NOTHING. A constant id
   * would have made that test pass whether the memo worked or not.
   */
  readonly uploads: File[] = [];

  async upload(file: File) {
    this.uploads.push(file);
    return `file_${this.uploads.length}`;
  }

  normalizeError(error: unknown) {
    return {
      code: "provider_error" as const,
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

export function fakeProvider(...scripts: ProviderEvent[][]) {
  return new FakeProvider(scripts) as unknown as AgentProvider & FakeProvider;
}

/**
 * An image provider that renders nothing and counts how often it was asked to.
 *
 * THE COUNT IS THE POINT. The expensive property of `ctx.generateImage` is that
 * a replayed tool call does not render again — two minutes and an invoice line
 * per repeat — and the only way to assert it is to ask the provider how many
 * times it was called. A fake that merely returned bytes would let a memo that
 * does nothing pass every test about what comes back.
 */
export class FakeImageProvider {
  readonly model = "fake-image";
  readonly generated: { prompt: string; size?: string }[] = [];
  readonly edited: { prompt: string; images: number; mask: boolean }[] = [];

  constructor(private readonly bytes = "generated-png") {}

  private answer(size: string) {
    return {
      bytes: new TextEncoder().encode(this.bytes),
      mimeType: "image/png",
      size,
      usage: {
        inputTokens: 15,
        outputTokens: 196,
        totalTokens: 211,
        imageInputTokens: 0,
        imageOutputTokens: 196,
      },
    };
  }

  async generate(params: any) {
    this.generated.push({ prompt: params.prompt, size: params.size });
    return this.answer(params.size ?? "1024x1024");
  }

  async edit(params: any) {
    this.edited.push({
      prompt: params.prompt,
      images: params.images.length,
      mask: Boolean(params.mask),
    });
    return this.answer(params.size ?? "1024x1024");
  }

  normalizeError(error: unknown) {
    return {
      code: "provider_error" as const,
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

export function fakeImageProvider(bytes?: string) {
  return new FakeImageProvider(bytes) as unknown as any;
}
