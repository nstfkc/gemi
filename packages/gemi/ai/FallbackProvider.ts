import type { ReasoningEffort } from "./Agent";
import {
  AgentProvider,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderStream,
  type ProviderStreamParams,
} from "./AgentProvider";
import {
  type CircuitOutcome,
  type CircuitPolicy,
  type CircuitState,
  type CircuitStore,
  MemoryCircuitStore,
} from "./CircuitStore";
import { httpErrorDetail } from "./providers/errors";
import { addUsage, emptyUsage } from "./runtime";
import type { AgentError, Usage } from "./types";

/**
 * An ordered chain of providers (#666): the primary, then the fallbacks.
 *
 * It is a provider itself, so `Agent`, `generate()` and the controller take it
 * where they take any other, and nothing above the provider learns there is a
 * chain. That is the point: the alternative was a `providers: [...]` option on
 * `Agent`, and every place that reads `config.provider` would have had to
 * answer "which one?".
 *
 * THE ONE RULE THAT SHAPES EVERYTHING: no fallback once output has reached the
 * consumer. A leg that has streamed a word, a reasoning summary or a tool call
 * has been seen — by the user, and by `Agent`, which already appended it to the
 * message — and a second model starting over would put two answers in one
 * message. So a leg's events are held back until its first content event, and
 * from that event on the leg is committed and a later error is final.
 *
 * Reasoning commits too, not only text, tool calls and structured output. It is
 * streamed to the client like text is, and a reasoning item is tied to the
 * deployment that wrote it: sending one leg's item back to another on the next
 * turn is a request the vendor may refuse. Holding reasoning back until the
 * answer starts would hide minutes of "thinking" from the UI on every call.
 */

/** One leg of a chain. */
export type FallbackEntry = {
  provider: AgentProvider;
  /**
   * How long this leg has to produce its FIRST event, in milliseconds. Past
   * that it is abandoned (its request aborted) and the next leg is tried. Once
   * any event has arrived, this deadline is off and the leg's own request
   * timeout applies — a slow answer that has started is not a dead one.
   *
   * Omitted: no deadline of the chain's own.
   */
  timeoutMs?: number;
  /**
   * Overrides `ProviderStreamParams.reasoning` for this leg. Models in one
   * chain take different effort values (#658), so the agent's single setting
   * is right for at most one of them. Dropped, as usual, by a provider whose
   * `capabilities.reasoning` is false.
   */
  reasoning?: ReasoningEffort;
  /**
   * The name this leg's circuit is kept under (#742). Default: the provider's
   * `model`. Set it when two legs share a model name (one model on two Azure
   * resources), or to share a leg's circuit between chains on purpose.
   */
  circuitKey?: string;
};

/** What `fallbackOn` is told besides the normalized error. */
export type FallbackFailure = {
  /** The leg's position in the chain this provider was built with (after `from()`). */
  index: number;
  model: string;
  /** The HTTP status of the failed response, when there was one. */
  status?: number;
  requestId?: string;
  /** True when the leg produced nothing within its `timeoutMs`. */
  timedOut: boolean;
};

/** One leg's report, for `onUsage`. Called once per leg that was tried. */
export type FallbackUsage = {
  /** The leg's position in this provider's chain. */
  index: number;
  /** The leg's configured model. */
  model: string;
  /**
   * The model the vendor says answered (`finish.model`): the snapshot behind an
   * alias, or the model behind an Azure deployment name. Absent when the leg
   * never got that far or its provider does not report it (#741).
   */
  responseModel?: string;
  /** 1 for the first leg tried in this call, 2 for the next one tried, and so
   *  on. A leg skipped by an open circuit is not tried and not counted. */
  attempt: number;
  /**
   * What the leg reported, including a failed leg that billed tokens (a
   * content filter does). Absent when the leg never reported usage: it timed
   * out, threw, or was abandoned.
   */
  usage?: Usage;
  /** `ok`: this leg answered (the call may still have failed after output). */
  outcome: "ok" | "fallback" | "failed" | "aborted";
  error?: AgentError;
};

export type FallbackOptions = {
  /**
   * Whether a failure moves on to the next leg. Default: `error.retryable`,
   * which `normalizeError` sets for a 429 that is not a spent quota, a 5xx, a
   * 408/409, a timeout and a network failure — and not for a request that would
   * fail the same way on any model (context length, a bad tool schema).
   *
   * Never asked about the last leg, about a user abort, or about a failure
   * after output.
   */
  fallbackOn?: (error: AgentError, failure: FallbackFailure) => boolean;
  /** Per-leg usage. An exception thrown here is swallowed: accounting must not
   *  fail the call it is accounting for. */
  onUsage?: (report: FallbackUsage) => void;
  /**
   * Skip a leg that keeps failing (#742). Off when omitted; `{}` turns it on
   * with the defaults. See `FallbackCircuit`.
   */
  circuit?: FallbackCircuit;
};

/**
 * A circuit breaker per leg. A leg whose calls fail `failures` times in a row,
 * in a way the chain falls back on (a timeout, a 5xx, a 429 — whatever
 * `fallbackOn` says yes to), is skipped for `cooldownMs`, so a dead primary
 * stops costing its `timeoutMs` on every call. After the cool-down one call
 * tries it again: an answer closes the circuit, a failure opens it for another
 * cool-down.
 *
 * The last leg is never skipped, so a chain always tries something, and its
 * failures are not counted (it is never asked `fallbackOn`). A leg that started
 * answering counts as a success even if it failed later: it is up.
 */
export type FallbackCircuit = {
  /** Failures in a row that open a leg's circuit. Default 3. */
  failures?: number;
  /** How long an open circuit skips its leg, in milliseconds. Default 30 000. */
  cooldownMs?: number;
  /**
   * Where the state lives. Default: a `MemoryCircuitStore` made for this chain,
   * shared with the chains `from()` and `leg()` derive from it, and with no
   * other — so a circuit is per process. See `CircuitStore` for why.
   */
  store?: CircuitStore;
  /** Told when a leg's circuit opens or closes. Exceptions are swallowed. */
  onStateChange?: (change: FallbackCircuitChange) => void;
};

export type FallbackCircuitChange = {
  index: number;
  model: string;
  key: string;
  state: CircuitState;
};

/** Every event that is content a consumer shows or stores. The first one commits its leg. */
function isContent(event: ProviderEvent): boolean {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta":
    case "tool-call-delta":
    case "tool-call":
    case "tool-search":
    case "output-delta":
      return true;
    default:
      return false;
  }
}

const TIMED_OUT = Symbol("timed-out");

export class FallbackProvider extends AgentProvider {
  /** The first leg's model: the one the chain is named after in logs. */
  readonly model: string;
  /**
   * The intersection of every leg's capabilities. A tool or a structured output
   * one leg cannot handle would otherwise be found the day the primary is down,
   * which is the worst day to find it. `Agent` drops what is false here, so a
   * chain behaves the same whichever leg answers.
   */
  readonly capabilities: ProviderCapabilities;
  readonly entries: readonly FallbackEntry[];
  private readonly options: FallbackOptions;
  private readonly circuit:
    | {
        policy: CircuitPolicy;
        store: CircuitStore;
        onStateChange?: (change: FallbackCircuitChange) => void;
      }
    | undefined;

  constructor(entries: readonly FallbackEntry[], options: FallbackOptions = {}) {
    super();
    if (entries.length === 0) {
      throw new Error("FallbackProvider needs at least one provider.");
    }
    for (const entry of entries) {
      if (entry.timeoutMs !== undefined && !(entry.timeoutMs > 0)) {
        throw new Error(
          `FallbackProvider: timeoutMs for ${entry.provider.model} must be a positive number, got ${entry.timeoutMs}.`,
        );
      }
    }
    this.entries = [...entries];
    const circuit = options.circuit;
    if (circuit) {
      const failures = circuit.failures ?? 3;
      const cooldownMs = circuit.cooldownMs ?? 30_000;
      if (!Number.isInteger(failures) || failures < 1) {
        throw new Error(
          `FallbackProvider: circuit.failures must be a positive integer, got ${failures}.`,
        );
      }
      if (!(cooldownMs > 0)) {
        throw new Error(
          `FallbackProvider: circuit.cooldownMs must be a positive number, got ${cooldownMs}.`,
        );
      }
      const keys = new Set<string>();
      for (const entry of entries) {
        const key = circuitKey(entry);
        if (keys.has(key)) {
          throw new Error(
            `FallbackProvider: two legs share the circuit key "${key}". ` +
              "Give one of them a `circuitKey`.",
          );
        }
        keys.add(key);
      }
      // Made here, once, and written back into the options, so `from()` and
      // `leg()` — which pass the options on — share it rather than each
      // starting with every circuit closed.
      const store = circuit.store ?? new MemoryCircuitStore();
      this.options = { ...options, circuit: { ...circuit, store } };
      this.circuit = {
        policy: { failures, cooldownMs },
        store,
        ...(circuit.onStateChange ? { onStateChange: circuit.onStateChange } : {}),
      };
    } else {
      this.options = options;
      this.circuit = undefined;
    }
    this.model = entries[0]!.provider.model;
    this.capabilities = intersect(entries.map((entry) => entry.provider.capabilities));
  }

  static chain(entries: readonly FallbackEntry[], options?: FallbackOptions): FallbackProvider {
    return new FallbackProvider(entries, options);
  }

  /**
   * The same chain entered at `index`. For work that should never reach the
   * primary — a cheap text task on an expensive chain — without a second chain
   * to keep in step. Same options; `index` in reports counts from the new start.
   */
  from(index: number): FallbackProvider {
    if (!Number.isInteger(index) || index < 0 || index >= this.entries.length) {
      throw new RangeError(
        `FallbackProvider.from(${index}): the chain has ${this.entries.length} entries.`,
      );
    }
    return new FallbackProvider(this.entries.slice(index), this.options);
  }

  /** The leg at `index` on its own, with its reasoning and timeout. What `evalChain` runs. */
  leg(index: number): FallbackProvider {
    const entry = this.from(index).entries[0]!;
    return new FallbackProvider([entry], this.options);
  }

  /**
   * To the first leg only. A provider's file id is not portable (#443): an id
   * from one OpenAI account or Azure resource means nothing to another, so
   * uploading to every leg would cost N uploads for ids nobody could choose
   * between. Legs on the same Azure resource share its files, which is the
   * common chain; a chain across accounts should keep files out of the
   * fallback path or store them with gemi.
   */
  upload(file: File): Promise<string> {
    return this.entries[0]!.provider.upload(file);
  }

  normalizeError(error: unknown): AgentError {
    return this.entries[0]!.provider.normalizeError(error);
  }

  stream(params: ProviderStreamParams): ProviderStream {
    return this.run(params);
  }

  private async *run(params: ProviderStreamParams): AsyncGenerator<ProviderEvent> {
    // What the abandoned legs billed. Added to the closing `finish`, so the
    // run's usage is what the call cost rather than what the winning leg cost.
    let billed: Usage | undefined;
    const outer = params.signal;

    let attempt = 0;

    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index]!;
      const last = index === this.entries.length - 1;
      const model = entry.provider.model;

      // An open circuit skips the leg without a request. Never the last one.
      if (this.circuit && !last && !(await this.allow(entry))) continue;
      attempt += 1;
      // What this leg's call says about its health, told to the breaker once.
      // Before anything is yielded for it, so a consumer that stops reading
      // does not leave a half-open probe hanging until it is given up on.
      let told = false;
      const tell = async (outcome: CircuitOutcome) => {
        if (told) return;
        told = true;
        await this.record(index, entry, outcome);
      };

      const leg = new AbortController();
      const onAbort = () => leg.abort(outer?.reason);
      if (outer?.aborted) leg.abort(outer.reason);
      else outer?.addEventListener("abort", onAbort, { once: true });

      const held: ProviderEvent[] = [];
      let committed = false;
      let finished = false;
      let usage: Usage | undefined;
      let responseModel: string | undefined;
      let failure: { error: AgentError; status?: number; requestId?: string } | undefined;
      let timedOut = false;
      let iterator: AsyncIterator<ProviderEvent> | undefined;
      let done = false;

      const closing = (event: Extract<ProviderEvent, { type: "finish" }>) => {
        const merged = billed ? addUsage(addUsage(emptyUsage(), billed), event.usage) : event.usage;
        billed = undefined;
        return { ...event, usage: merged };
      };

      try {
        iterator = entry.provider
          .stream({
            ...params,
            ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
            signal: leg.signal,
          })
          [Symbol.asyncIterator]();

        let first = true;
        for (;;) {
          const next =
            first && entry.timeoutMs !== undefined
              ? await withDeadline(iterator.next(), entry.timeoutMs)
              : await iterator.next();
          if (next === TIMED_OUT) {
            timedOut = true;
            failure = {
              error: {
                code: "provider_error",
                message: `${model} sent nothing within ${entry.timeoutMs}ms.`,
                retryable: true,
              },
            };
            break;
          }
          first = false;
          if (next.done) {
            done = true;
            break;
          }
          const event = next.value;

          if (event.type === "finish" && event.model) responseModel = event.model;

          if (committed) {
            if (event.type === "finish") {
              usage = addUsage(usage ?? emptyUsage(), event.usage);
              finished = true;
              yield closing(event);
            } else {
              if (event.type === "error") failure = { error: event.error };
              yield event;
            }
            continue;
          }

          if (isContent(event)) {
            committed = true;
            await tell("success");
            yield* held.splice(0);
            yield event;
            continue;
          }

          if (event.type === "error") {
            failure = {
              error: event.error,
              ...(event.status !== undefined ? { status: event.status } : {}),
              ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
            };
          } else if (event.type === "finish") {
            usage = addUsage(usage ?? emptyUsage(), event.usage);
            if (event.reason === "error" && !failure) {
              failure = {
                error: {
                  code: "provider_error",
                  message: `${model} ended the call with an error and did not say which.`,
                  retryable: false,
                },
              };
            }
          }
          held.push(event);
        }
      } catch (thrown) {
        // A custom provider is allowed to throw rather than send an error event;
        // the built-in ones never do. It reads the same either way.
        const error = entry.provider.normalizeError(thrown);
        if (committed) {
          if (error.code !== "aborted") {
            yield { type: "error", error, ...httpErrorDetail(thrown) };
          }
          this.report({
            index,
            model,
            responseModel,
            attempt,
            usage,
            outcome: outcomeOf(error),
            error,
          });
          yield closing({
            type: "finish",
            reason: error.code === "aborted" ? "aborted" : "error",
            usage: emptyUsage(),
            ...(responseModel ? { model: responseModel } : {}),
          });
          return;
        }
        failure = { error, ...httpErrorDetail(thrown) };
      } finally {
        outer?.removeEventListener("abort", onAbort);
        // Abandoned (timed out, fell back, or the consumer stopped reading):
        // stop its request and let it go without waiting for it to agree.
        if (!done) {
          leg.abort();
          void iterator?.return?.()?.catch(() => {});
        }
      }

      if (committed) {
        if (!finished && billed) {
          // The leg ended without a closing frame; the abandoned legs' cost
          // still has to be told to someone.
          yield { type: "finish", reason: failure ? "error" : "stop", usage: billed };
          billed = undefined;
        }
        this.report({
          index,
          model,
          responseModel,
          attempt,
          usage,
          outcome: failure ? outcomeOf(failure.error) : "ok",
          ...(failure ? { error: failure.error } : {}),
        });
        return;
      }

      // The consumer stopped the run. Not a failure of this leg, and certainly
      // not one to answer by asking the next model.
      if (outer?.aborted) {
        await tell("none");
        this.report({ index, model, responseModel, attempt, usage, outcome: "aborted" });
        yield closing({
          type: "finish",
          reason: "aborted",
          usage: usage ?? emptyUsage(),
          ...(responseModel ? { model: responseModel } : {}),
        });
        return;
      }

      if (!failure) {
        // Answered with nothing: a finish and no content. That is an answer.
        await tell("success");
        this.report({ index, model, responseModel, attempt, usage, outcome: "ok" });
        for (const event of held) yield event.type === "finish" ? closing(event) : event;
        return;
      }

      const fallback =
        !last &&
        failure.error.code !== "aborted" &&
        this.shouldFallBack(failure.error, {
          index,
          model,
          timedOut,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          ...(failure.requestId !== undefined ? { requestId: failure.requestId } : {}),
        });

      // A leg's failure counts against it only when the chain moves on from
      // it: a request any model would refuse says nothing about this one. The
      // last leg is never asked, so its failures are not counted.
      await tell(fallback ? "failure" : "none");
      this.report({
        index,
        model,
        responseModel,
        attempt,
        usage,
        outcome: fallback ? "fallback" : outcomeOf(failure.error),
        error: failure.error,
      });

      if (fallback) {
        if (usage) billed = addUsage(billed ?? emptyUsage(), usage);
        continue;
      }

      // Final: say what this leg said, in its order, and close the call.
      let sawError = false;
      let closingFinish: Extract<ProviderEvent, { type: "finish" }> | undefined;
      for (const event of held) {
        if (event.type === "finish") {
          closingFinish = event;
          continue;
        }
        if (event.type === "error") sawError = true;
        yield event;
      }
      if (!sawError && failure.error.code !== "aborted") {
        yield {
          type: "error",
          error: failure.error,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          ...(failure.requestId !== undefined ? { requestId: failure.requestId } : {}),
        };
      }
      yield closing({
        type: "finish",
        reason: failure.error.code === "aborted" ? "aborted" : (closingFinish?.reason ?? "error"),
        usage: usage ?? emptyUsage(),
        ...(responseModel ? { model: responseModel } : {}),
      });
      return;
    }
  }

  private async allow(entry: FallbackEntry): Promise<boolean> {
    if (!this.circuit) return true;
    try {
      return await this.circuit.store.allow(circuitKey(entry), this.circuit.policy);
    } catch {
      // A breaker that cannot be read must not stop the primary being tried.
      return true;
    }
  }

  private async record(index: number, entry: FallbackEntry, outcome: CircuitOutcome) {
    if (!this.circuit) return;
    const key = circuitKey(entry);
    let state: CircuitState | undefined;
    try {
      state = await this.circuit.store.record(key, outcome, this.circuit.policy);
    } catch {
      return;
    }
    if (!state) return;
    try {
      this.circuit.onStateChange?.({ index, model: entry.provider.model, key, state });
    } catch {
      // Same rule as `onUsage`.
    }
  }

  private shouldFallBack(error: AgentError, failure: FallbackFailure): boolean {
    const decide = this.options.fallbackOn ?? ((e: AgentError) => e.retryable);
    try {
      return decide(error, failure);
    } catch {
      return false;
    }
  }

  private report(report: FallbackUsage): void {
    if (report.usage === undefined) delete report.usage;
    if (report.responseModel === undefined) delete report.responseModel;
    try {
      this.options.onUsage?.(report);
    } catch {
      // See `FallbackOptions.onUsage`.
    }
  }
}

function circuitKey(entry: FallbackEntry): string {
  return entry.circuitKey ?? entry.provider.model;
}

function outcomeOf(error: AgentError): FallbackUsage["outcome"] {
  return error.code === "aborted" ? "aborted" : "failed";
}

function intersect(all: ProviderCapabilities[]): ProviderCapabilities {
  return {
    reasoning: all.every((c) => c.reasoning),
    structuredOutput: all.every((c) => c.structuredOutput),
    fileInput: all.every((c) => c.fileInput),
    parallelToolCalls: all.every((c) => c.parallelToolCalls),
    toolSearch: all.every((c) => c.toolSearch),
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// --- evalChain ------------------------------------------------------------

export type EvalChainResult<T> = {
  index: number;
  model: string;
  /** One per sample that resolved, in sample order. */
  results: T[];
  /** One per sample that threw, with the sample number it came from. */
  errors: { sample: number; error: unknown }[];
};

/**
 * Runs `fixture` against every leg on its own — no fallback between them —
 * `samples` times each, and returns the outcomes per leg. For comparing the
 * models in a chain before reordering it: the fixture builds an `Agent` (or
 * calls `generate()`) with the provider it is handed and returns whatever is
 * worth comparing.
 *
 * Legs run one after another and samples in sequence, so a rate limit on one
 * leg does not skew another's numbers.
 */
export async function evalChain<T>(
  chain: FallbackProvider,
  fixture: (provider: AgentProvider, context: { index: number; sample: number }) => Promise<T>,
  options: { samples?: number } = {},
): Promise<EvalChainResult<T>[]> {
  const samples = options.samples ?? 1;
  if (!Number.isInteger(samples) || samples < 1) {
    throw new RangeError(`evalChain: samples must be a positive integer, got ${samples}.`);
  }
  const out: EvalChainResult<T>[] = [];
  for (let index = 0; index < chain.entries.length; index++) {
    const provider = chain.leg(index);
    const result: EvalChainResult<T> = { index, model: provider.model, results: [], errors: [] };
    for (let sample = 0; sample < samples; sample++) {
      try {
        result.results.push(await fixture(provider, { index, sample }));
      } catch (error) {
        result.errors.push({ sample, error });
      }
    }
    out.push(result);
  }
  return out;
}
