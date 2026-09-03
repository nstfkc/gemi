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

  async upload() {
    return "file_1";
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
