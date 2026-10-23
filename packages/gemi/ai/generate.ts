import { Log } from "../facades/Log";
import { AgentRunError, type AgentRunFailure, type ReasoningEffort } from "./Agent";
import type { AgentProvider } from "./AgentProvider";
import { httpErrorDetail } from "./providers/errors";
import {
  addUsage,
  appendReasoning,
  appendText,
  emptyUsage,
  outputFormat,
  parseOutput,
  raceAbort,
  resolveRope,
  RunAborted,
} from "./runtime";
import type { Infer, Schema } from "./Schema";
import type { AgentError, AgentMessage, FinishReason, Usage } from "./types";
import { recordUsage } from "./usageMeter";

/**
 * One model call with an output schema: no tools, no loop, no stream to a client.
 *
 *     const result = await generate({
 *       provider,
 *       instructions: "You are the copywriter of …",
 *       prompt: `The business: ${description}`,
 *       output: s.object({ headline: s.string(), cta: s.string() }),
 *     });
 *     if (result.ok) save(result.output);
 *
 * WHAT IT IS FOR. Before this, the only structured generation gemi offered was
 * an `Agent` with an `output` schema, and an app that wanted one typed answer
 * got a tool loop it did not want and — through `ctx.runAgent` — a nested
 * transcript streamed to the browser for a value the browser never renders
 * (#594, #595). This is the agent's step without the agent: it assembles the
 * same provider call and parses the answer the same way (`runtime.ts` holds
 * both halves, shared), and that is all it does.
 *
 * INSIDE A TOOL, CALL `ctx.generate` INSTEAD. It is this function with the turn
 * bound in, not a second implementation: it aborts when the turn is stopped and
 * adds its usage to the turn's, two things a tool passing `ctx.signal` by hand
 * would forget invisibly. See `ToolContext.generate`.
 *
 * IT DOES NOT THROW FOR A BAD ANSWER. It returns `{ ok: false, error }`, and
 * `messages` and `usage` are on both arms. That is the requesting app's retry
 * pattern, and the reason for the shape: a rejected answer is retried by
 * continuing the conversation — `messages` plus "your output was rejected:
 * <problems>" — so the transcript holding the reply that failed is exactly
 * what the retry needs, and a throw would have lost it or buried it on an
 * exception. Usage is on both because the tokens were billed either way, and
 * the failed attempt is the one an app repeats. It is also how the rest of the
 * module already reports: `Schema.safeParse` returns a result, and a failing
 * tool is a result the model reads. Pass `throwOnError: true` to have it
 * reject with an `AgentRunError` instead, as `run.result()` can.
 *
 * OR LET IT RETRY (#1017). `validate` checks a parsed answer against the
 * app's own rules, and an answer that fails is asked again with the problems,
 * up to `attempts` times:
 *
 *     const result = await generate({
 *       provider, instructions, prompt, output,
 *       validate: (brief) => [brief.sections.length !== n && `List exactly ${n} sections.`],
 *       attempts: 3,
 *       attemptTimeoutMs: 150_000,
 *     });
 *
 * The loop is the pattern above written once: a rejected answer continues the
 * conversation, a cut-off or timed-out one is asked again without it, a
 * retryable provider error is sent again, the usage is summed (and listed per
 * attempt on `attemptLog`), and a loop that never passes resolves `ok: false`
 * with the last rejected answer on `rejected`. See `GenerateParams.validate`.
 *
 * A FAILURE IS LOGGED through `Log.error` by default, as a failed agent run is
 * (`logErrors: false` turns it off); a stop is not a failure and is not. On
 * `ok: false`, `error` also carries the provider's HTTP `status` and
 * `requestId` when it answered with an error, as `result().error` does.
 *
 * `error.code` says which failure it was:
 *
 *   - `invalid_output` — the answer did not match the schema, was cut off at
 *     `maxOutputTokens` (then `finishReason` is `"length"`), or never came.
 *   - `timeout` — `signal` fired with a `TimeoutError`: an
 *     `AbortSignal.timeout`, or the tool's `timeoutMs` under `ctx.generate`.
 *   - `aborted` — `signal` fired for any other reason: a stop.
 *   - anything else — the provider failed, normalized by the provider's own
 *     `normalizeError` exactly as a failed agent step is (`rate_limited`,
 *     `content_filtered`, `provider_error`, …).
 *
 * The one thing that does throw is a call that could never work: neither
 * `prompt` nor `messages`. That is a bug in the caller, not an outcome.
 *
 * NOT MEMOIZED, AND NOT RECORDED. It writes nothing to a thread and sends no
 * frame, which is the point of it — and it also means a tool body that is
 * re-entered after an escalation (see `ToolContext.runAgent`) calls the model
 * again. `ctx.runAgent` and `ctx.generateImage` can replay because they record
 * on the tool call; this has nothing to record into by design.
 */
export function generate<O extends Schema<any>, R = Infer<O>>(
  params: GenerateParams<O, R> & { throwOnError: true },
): Promise<GenerateSuccess<R>>;
export function generate<O extends Schema<any>, R = Infer<O>>(
  params: GenerateParams<O, R>,
): Promise<GenerateResult<R, Infer<O>>>;
export function generate(params: GenerateParams): Promise<GenerateResult<unknown>> {
  return generateWithin(params);
}

/**
 * Where a `generate` call was made from, for its log line: `ctx.generate`
 * passes the agent, run and tool call it belongs to.
 */
export type GenerateOrigin = Record<string, unknown>;

/**
 * `generate`, plus what `ctx.generate` needs to bind it to a turn: the origin
 * for the log line, and `settled`, which sees the result before it is logged
 * or thrown. That is where the turn adds the usage (billed whether or not the
 * answer parsed, and whether or not it is about to throw) and throws when the
 * turn itself was stopped. With `attempts`, `settled` sees the whole loop once,
 * with the usage of every attempt summed.
 */
export async function generateWithin(
  params: GenerateParams,
  hooks: { origin?: GenerateOrigin; settled?: (result: GenerateResult<unknown>) => void } = {},
): Promise<GenerateResult<unknown>> {
  // An id for the call, so the log line and an `AgentRunError` can be matched
  // up. `gen_` rather than `run_`: there is no run, and nothing is stored.
  const id = `gen_${crypto.randomUUID()}`;
  const result = await callUntilValid(params);
  hooks.settled?.(result);
  if (!result.ok) {
    // A stop is an outcome the caller asked for, not a failure — the same rule
    // an agent run follows (an aborted run carries no `error` and is not
    // logged). A timeout is a failure: it reports `timeout`, as a run's
    // deadline does, and is logged. A loop of attempts is logged once, here,
    // not once per attempt: a rejected attempt is expected now and then.
    if (params.logErrors !== false && result.error.code !== "aborted") {
      logFailure(id, result.error, hooks.origin);
    }
    if (params.throwOnError) {
      throw new AgentRunError(
        {
          runId: id,
          messages: result.messages,
          finishReason: result.finishReason,
          usage: result.usage,
          error: result.error,
        },
        result.rejected ? { rejected: result.rejected } : undefined,
      );
    }
  }
  return result;
}

// The longest a retry waits for a provider's `retryAfter`. Past it, waiting
// holds the caller up for longer than asking again and failing costs.
const MAX_RETRY_WAIT_MS = 30_000;

/**
 * The repair loop: call, parse, `validate`, and ask again with the problems
 * until an answer passes or `attempts` run out. With neither `validate` nor
 * `attempts` it is one `callModel`, returned as it came.
 *
 * WHAT THE NEXT ATTEMPT SENDS is `base` (the transcript) plus one user turn,
 * `request` with `note` after it:
 *
 *   - continue: the rejected reply joins the transcript and the feedback is
 *     the next turn, so the model corrects its own answer. A rejection by
 *     `validate`, and a schema mismatch by default.
 *   - restart: the transcript stays as it was before the attempt and the
 *     feedback is added to the same turn as a note. For an answer that is no
 *     draft to correct: one cut off at `maxOutputTokens` (a truncated reply
 *     the model would only copy into the same wall), one stopped by
 *     `attemptTimeoutMs`, and whatever `validate` sends back with
 *     `retry: "restart"`. A later restart replaces the note, never stacks it.
 *   - again: a retryable provider error sends exactly the same thing.
 */
async function callUntilValid(params: GenerateParams): Promise<GenerateResult<unknown>> {
  if (params.timeoutMs === undefined) return repairLoop(params, params.signal);
  // The deadline is a timer of our own rather than `AbortSignal.timeout`.
  // Under Bun 1.3, a timeout signal whose last `abort` listener is removed
  // never aborts. `raceAbort` removes its listener when each call ends, so the
  // deadline died after the first attempt and a slow `validate` or a later
  // attempt was never bounded (#1037). The reason is the same `TimeoutError`
  // `AbortSignal.timeout` gives, which `abortError` reports as `timeout`.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("The operation timed out.", "TimeoutError")),
    params.timeoutMs,
  );
  try {
    return await repairLoop(params, anySignal(params.signal, deadline.signal));
  } finally {
    clearTimeout(timer);
  }
}

async function repairLoop(
  params: GenerateParams,
  // The overall bound: the caller's signal, and `timeoutMs` over every attempt
  // and every validation.
  outer: AbortSignal | undefined,
): Promise<GenerateResult<unknown>> {
  const validate = params.validate;
  const attempts = Math.max(1, Math.floor(params.attempts ?? (validate ? 3 : 1)));
  const feedback = params.feedback ?? defaultFeedback;
  const onInvalidOutput = params.onInvalidOutput ?? "continue";
  const retryErrors = params.retryErrors ?? true;
  let base: AgentMessage[] = params.messages ?? [];
  let request = params.prompt;
  let note = "";
  let usage = emptyUsage();
  const attemptLog: GenerateAttempt[] = [];
  let rejected: GenerateRejection<unknown> | undefined;
  let last: Called<unknown> | undefined;

  const finish = (result: Called<unknown>): GenerateResult<unknown> =>
    ({
      ...result,
      usage,
      attempts: attemptLog.length,
      attemptLog,
      ...(!result.ok && rejected ? { rejected } : {}),
    }) as GenerateResult<unknown>;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Stopped between attempts (during a validation or a `retryAfter` wait):
    // no call is made that would only be raced to an abort.
    if (attempt > 1 && outer?.aborted) {
      return finish({
        ok: false,
        error: abortError(outer),
        messages: last!.messages,
        usage,
        finishReason: "aborted",
      });
    }

    const started = Date.now();
    const timer = params.attemptTimeoutMs !== undefined ? new AbortController() : undefined;
    const handle =
      timer &&
      setTimeout(
        () => timer.abort(new DOMException("The attempt took too long.", "TimeoutError")),
        params.attemptTimeoutMs,
      );
    let result: Called<unknown>;
    try {
      result = await callModel({
        ...params,
        messages: base,
        prompt: note ? [request, note].filter(Boolean).join("\n\n") : request,
        signal: anySignal(outer, timer?.signal),
      });
    } finally {
      clearTimeout(handle);
    }
    last = result;
    usage = addUsage(usage, result.usage);
    const entry: GenerateAttempt = {
      attempt,
      outcome: "passed",
      durationMs: Date.now() - started,
      usage: result.usage,
      finishReason: result.finishReason,
    };
    const record = (fields: Partial<GenerateAttempt>) => {
      Object.assign(entry, fields);
      attemptLog.push(entry);
      params.onAttempt?.(entry);
    };
    const more = attempt < attempts;

    if (!result.ok) {
      const { error } = result;
      // The attempt's own timer, not the caller's signal or the deadline:
      // the answer ran on, and is asked again as a cut-off one is.
      const timedOut = !!timer?.signal.aborted && !outer?.aborted;
      const cutOff = error.code === "invalid_output" && result.finishReason === "length";
      if (timedOut || cutOff || error.code === "invalid_output") {
        const cause: GenerateFeedbackCause = timedOut
          ? "timeout"
          : cutOff
            ? "cut_off"
            : "invalid_output";
        const problems = timedOut
          ? [
              `The answer took longer than ${Math.round(params.attemptTimeoutMs! / 1000)} seconds and was stopped before it finished.`,
            ]
          : cutOff
            ? [error.message]
            : [`The output does not match the output schema: ${error.message}`];
        record({ outcome: cause, problems, error });
        const restart = cause !== "invalid_output" || onInvalidOutput === "restart";
        if (!more || (cause === "invalid_output" && onInvalidOutput === "fail")) {
          return finish(result);
        }
        const next = feedback(problems, { attempt, attempts, cause, restart });
        if (restart) {
          note = next;
        } else {
          base = result.messages;
          request = next;
          note = "";
        }
        continue;
      }
      record({ outcome: "error", error });
      // A retryable failure (a rate limit, a 5xx) has no answer to correct:
      // the same thing is sent again. A stop or the deadline is never retried.
      if (more && retryErrors && error.retryable && !outer?.aborted && !timer?.signal.aborted) {
        if (error.retryAfter) await pause(Math.min(error.retryAfter, MAX_RETRY_WAIT_MS), outer);
        continue;
      }
      return finish(result);
    }

    if (!validate) {
      record({});
      return finish(result);
    }
    const verdict = readVerdict(
      await validate(result.output, {
        attempt,
        attempts,
        messages: result.messages,
        signal: outer ?? NEVER,
      }),
    );
    if (verdict.ok === true) {
      record({});
      return finish({ ...result, output: verdict.value === KEEP ? result.output : verdict.value });
    }
    const problems = verdict.problems.length > 0 ? verdict.problems : ["The answer was rejected."];
    rejected = { output: result.output, problems };
    record({ outcome: "rejected", problems });
    if (!more || verdict.retry === false) {
      return finish({
        ok: false,
        error: {
          code: "invalid_output",
          message:
            verdict.retry === false
              ? `The answer was rejected:\n${bullets(problems)}`
              : `The answer was rejected ${attempt === 1 ? "once" : `${attempt} times`}. The last attempt's problems:\n${bullets(problems)}`,
          retryable: verdict.retry !== false,
        },
        messages: result.messages,
        usage,
        finishReason: result.finishReason,
      });
    }
    const restart = verdict.retry === "restart";
    const next = feedback(problems, { attempt, attempts, cause: "rejected", restart });
    if (restart) {
      note = next;
    } else {
      base = result.messages;
      request = next;
      note = "";
    }
  }
  // Unreachable: the last attempt always returns above.
  return finish(last!);
}

// A signal that never fires, for `validate`'s `info.signal` when the caller
// gave none.
const NEVER = new AbortController().signal;
// `validate` passed without a value of its own: the output stands.
const KEEP = Symbol("keep");

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const given = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return given.length <= 1 ? given[0] : AbortSignal.any(given);
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function bullets(problems: readonly string[]): string {
  return problems.map((problem) => `- ${problem}`).join("\n");
}

function readVerdict(
  verdict: GenerateVerdict<unknown>,
):
  | { ok: true; value: unknown }
  | { ok: false; problems: string[]; retry?: "continue" | "restart" | false } {
  const keep = (problems: readonly GenerateProblem[]) =>
    problems.filter((problem): problem is string => typeof problem === "string" && problem !== "");
  if (verdict === undefined || verdict === null) return { ok: true, value: KEEP };
  if (Array.isArray(verdict)) {
    const problems = keep(verdict);
    return problems.length === 0 ? { ok: true, value: KEEP } : { ok: false, problems };
  }
  const object = verdict as Exclude<GenerateVerdict<unknown>, readonly unknown[] | void>;
  if (object.ok === true) return { ok: true, value: object.value };
  return { ok: false, problems: keep(object.problems), retry: object.retry };
}

/** The next prompt when `feedback` is not given. */
function defaultFeedback(problems: string[], info: GenerateFeedbackInfo): string {
  return info.restart
    ? `A previous answer to this could not be used:\n${bullets(problems)}\n\nAnswer again, in full.`
    : `Your answer was rejected:\n${bullets(problems)}\n\nCorrect these problems and give the whole answer again.`;
}

/**
 * Through the app's logger, as a failed agent run is (`AgentRunImpl.logFailure`):
 * `Log.error`, so it lands in `storage/logs` and `onLogCreated`; outside an
 * application, where there is no logger to resolve, `console.error` instead;
 * and in development the console as well.
 */
function logFailure(id: string, failure: AgentRunFailure, origin?: GenerateOrigin): void {
  const message = `[gemi/ai] generate() failed (${failure.code}${
    failure.status !== undefined ? ` ${failure.status}` : ""
  }): ${failure.message}`;
  const metadata = { ...origin, generateId: id, error: failure };
  let logged = false;
  try {
    Log.error(message, metadata);
    logged = true;
  } catch {
    // No application to resolve a logger from. Reported below instead.
  }
  if (!logged || process.env.NODE_ENV === "development") {
    console.error(message, metadata);
  }
}

/** One call's result, before the loop adds what it knows: the attempt count,
 *  the log and the summed usage. */
type Called<O> =
  GenerateResult<O> extends infer R
    ? R extends unknown
      ? Omit<R, "attempts" | "attemptLog" | "rejected">
      : never
    : never;

async function callModel<O extends Schema<any>>(
  params: GenerateParams<O>,
): Promise<Called<Infer<O>>> {
  const prior = params.messages ?? [];
  if (prior.length === 0 && !params.prompt) {
    throw new Error(
      "generate() was given neither a `prompt` nor `messages`, so there is nothing to send the model.",
    );
  }

  const messages: AgentMessage[] = [...prior];
  if (params.prompt) {
    messages.push({
      id: `msg_${crypto.randomUUID()}`,
      role: "user",
      content: [{ type: "text", text: params.prompt }],
      createdAt: new Date().toISOString(),
    });
  }
  const reply: AgentMessage = {
    id: `msg_${crypto.randomUUID()}`,
    role: "assistant",
    content: [],
    createdAt: new Date().toISOString(),
  };

  // `raceAbort` wants a signal to race, and a caller with none gets one that
  // never fires rather than a second code path.
  const signal = params.signal ?? new AbortController().signal;
  let usage = emptyUsage();
  let reason: FinishReason = "stop";
  let error: AgentError | undefined;
  // The HTTP status and request id of a failed provider response, as an agent
  // run records them on `result().error` (#656). Server-side only.
  let detail: { status?: number; requestId?: string } = {};
  let outputText = "";

  try {
    const stream = params.provider.stream({
      // A copy: the provider is handed the array and has no business growing
      // the one this function is about to return.
      messages: [...messages],
      systemPrompt: params.instructions?.trim() ? params.instructions : undefined,
      output: outputFormat(params.output),
      reasoning: params.reasoning,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      signal: params.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        // Raced, as the agent's step is: a provider that ignores its signal
        // must not be able to hold a stopped call open.
        const next = await raceAbort(Promise.resolve(iterator.next()), signal);
        if (next.done) break;
        const event = next.value;
        switch (event.type) {
          case "output-delta":
            outputText += event.delta;
            break;
          // Kept on the reply for what they are worth to a retry: reasoning
          // carries its item id so a continuation echoes it back and keeps the
          // prompt cache, and prose is what a model that ignored the format
          // said instead.
          case "text-delta":
            appendText(reply, "text", event.delta);
            break;
          case "reasoning-delta":
            appendReasoning(reply, event.id, event.delta);
            break;
          case "finish":
            // Usage is taken whatever happened before it; the reason only if
            // nothing already failed. A content filter reports an error and
            // then closes the call with a finish that still bills — the same
            // rule `AgentRunImpl.runStep` follows.
            usage = addUsage(usage, event.usage);
            recordUsage(event.model ?? params.provider.model, event.usage);
            if (!error) reason = event.reason;
            break;
          case "error":
            reason = "error";
            error = event.error;
            detail = httpErrorDetail(event);
            break;
          // `tool-call-delta`, `tool-call` and `tool-search` cannot happen:
          // no tools were sent.
          // `file-rejected` needs nothing here: the provider already sent the
          // call again without that file, and `generate()` keeps no thread
          // to mark the part in. The caller's `messages` are its own.
        }
      }
    } finally {
      // Not awaited. On the abort path the generator may be parked inside a
      // `fetch` that ignores its signal, and waiting on it would give back
      // the hang the race above exists to prevent.
      if (signal.aborted) void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  } catch (thrown) {
    if (thrown instanceof RunAborted || signal.aborted) {
      reason = "aborted";
      error = abortError(signal);
    } else {
      reason = "error";
      error = params.provider.normalizeError(thrown);
      detail = httpErrorDetail(thrown);
    }
  }

  // A flag rather than `output !== undefined`: the schema decides what a
  // valid answer is, and nothing says it cannot be a falsy one.
  let answered = false;
  let output: Infer<O> | undefined;
  if (!error) {
    if (reason === "length") {
      // Never parsed. A cut-off answer is a prefix of the JSON the model meant
      // to write, `bestEffortParse` closes its brackets, and against a loose
      // schema — `s.json()` — the repaired half passes looking finished. The
      // agent loop withholds its `output` part for the same reason.
      error = {
        code: "invalid_output",
        message:
          "The model ran out of output tokens before finishing its structured answer, so it was cut off. Raise maxOutputTokens, or ask for a shorter answer.",
        retryable: true,
      };
    } else if (!outputText.trim()) {
      error = {
        code: "invalid_output",
        message: "The model finished without giving a structured answer.",
        retryable: true,
      };
    } else {
      const parsed = parseOutput(params.output, outputText);
      if (parsed.ok === true) {
        answered = true;
        output = parsed.value as Infer<O>;
      } else {
        error = parsed.error;
      }
    }
  }

  if (answered) {
    reply.content.push({ type: "output", value: output });
  } else if (outputText) {
    // The answer that failed, as the model wrote it. A retry continues this
    // transcript, and "your output did not parse" means little to a model that
    // cannot see what it wrote. Text rather than an `output` part because it is
    // not a value of the schema — an `output` part promises one.
    appendText(reply, "text", outputText);
  }
  for (const part of reply.content) {
    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
      part.text = resolveRope(part.text);
    }
  }
  reply.finishReason = reason;
  // One call, one message: the reply's usage is the call's, as an agent step's
  // message carries its own (#467).
  reply.usage = usage;
  messages.push(reply);

  if (answered) {
    return { ok: true, output: output as Infer<O>, messages, usage, finishReason: reason };
  }
  return { ok: false, error: { ...error!, ...detail }, messages, usage, finishReason: reason };
}

function abortError(signal: AbortSignal): AgentError {
  // `AbortSignal.timeout()` aborts with a `TimeoutError` (and so does a tool's
  // `timeoutMs`, through `ctx.signal`), and saying so is the difference
  // between "somebody pressed stop" and "try again with more time".
  const timedOut = (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError";
  // The same code an agent run's deadline and a tool's `timeoutMs` report
  // (#455), so one branch on `"timeout"` covers all three.
  return timedOut
    ? { code: "timeout", message: "The generation timed out.", retryable: true }
    : { code: "aborted", message: "The generation was stopped.", retryable: false };
}

/** What `generate` and `ctx.generate` are given. `messages` and `prompt` are
 *  alternatives, and together the prompt is appended as the next user turn —
 *  the same pair `ctx.runAgent` takes, so a retry reads the same in both. */
export interface GenerateParams<O extends Schema<any> = Schema<any>, R = Infer<O>> {
  provider: AgentProvider;
  /**
   * The answer's shape, and the type of `output`. Required: a call without one
   * is a chat completion, which is not what this is.
   *
   * `strict` is read off the schema, as it is for an agent — a schema holding
   * an `s.json()` node is sent non-strict, since strict mode cannot express it.
   */
  output: O;
  /** The system prompt. */
  instructions?: string;
  /** Prior turns. Returned again at the front of `messages`, untouched. */
  messages?: AgentMessage[];
  /** Sugar for one more user turn, appended after `messages`. */
  prompt?: string;
  /** Dropped by a provider whose model cannot reason, as for an agent. */
  reasoning?: ReasoningEffort;
  /**
   * The provider's `max_output_tokens`. An answer that reaches it is cut off,
   * and comes back `ok: false` with `finishReason: "length"` — never as a
   * repaired half that happens to pass the schema.
   */
  maxOutputTokens?: number;
  /** Sent whenever set; a reasoning model that rejects it answers 400. See
   *  `CreateAgentParams.temperature`. */
  temperature?: number;
  /**
   * Stops the call; it then resolves `ok: false` with `code: "aborted"`, or
   * `code: "timeout"` when it aborted with a `TimeoutError`.
   * `AbortSignal.timeout(ms)` is how to bound one.
   *
   * On `ctx.generate` this is combined with the turn's signal rather than
   * replacing it, so a timeout of the tool's own cannot unhook a `stop()`.
   */
  signal?: AbortSignal;
  /**
   * Reject with an `AgentRunError` instead of resolving `ok: false`, as
   * `run.result({ throwOnError: true })` does for an agent. Its `result` holds
   * the `messages`, `usage` and `error`, and its `runId` is the call's
   * `gen_` id. Any `ok: false` rejects, a stop included, since there is no
   * output to resolve with; the return type is then the `ok: true` arm.
   * Default `false`.
   */
  throwOnError?: boolean;
  /**
   * Write a failed call to the app's log (`Log.error`), as a failed agent run
   * is. Default `true`. A stop (`code: "aborted"`) is not a failure and is not
   * logged. Turn it off when the caller reports `result.error` itself — a
   * retry loop that expects `invalid_output` now and then, say.
   */
  logErrors?: boolean;

  // --- the repair loop ------------------------------------------------------

  /**
   * The app's own rules for an answer that parsed: called with the output, it
   * says whether the answer passes, and when it does not the model is asked
   * again with the problems (`feedback`), up to `attempts` times.
   *
   * It returns a verdict (`GenerateVerdict`):
   *
   *   - a list of problems — falsy entries are dropped, so `[cond && "…"]`
   *     reads as a checklist; an empty list (or nothing) passes, and
   *     `result.output` is the parsed answer;
   *   - `{ ok: true, value }` — passes, and `result.output` is `value`: the
   *     answer turned into what the app keeps (a patch, a mended copy);
   *   - `{ ok: false, problems, retry? }` — rejected. `retry` is `"continue"`
   *     (default: the reply stays in the transcript and the feedback is the
   *     next turn, so the model corrects its own answer), `"restart"` (the
   *     reply is dropped and the request asked again with the feedback as a
   *     note: for an answer that is no draft to correct), or `false` (stop
   *     now: the model declined, and asking again will not change that).
   *
   * It may be async and may have side effects (save, then report what the
   * save refused); `info.signal` fires with the caller's `signal` or
   * `timeoutMs`. A throw is not a verdict: it rejects `generate`.
   */
  validate?: (output: Infer<O>, info: GenerateValidateInfo) => MaybePromise<GenerateVerdict<R>>;
  /**
   * How many answers to ask for at most, the first included. Default 3 with
   * `validate`, 1 without — so a call without either is the single call it
   * always was. `attempts` alone retries schema mismatches, cut-off answers
   * and retryable provider errors.
   */
  attempts?: number;
  /**
   * The next prompt after an attempt that did not pass. `problems` are what
   * `validate` said, or gemi's description of the parse failure, cut-off or
   * timeout; `info.cause` says which and `info.restart` whether the text is
   * added to the same request (a restart) or sent as a new turn after the
   * rejected reply. Default: a short "rejected: - …" message in English.
   */
  feedback?: (problems: string[], info: GenerateFeedbackInfo) => string;
  /**
   * What a schema mismatch (`invalid_output` that was not cut off) does:
   * `"continue"` (default) sends the parse error back as a correction after
   * the reply, `"restart"` asks again without the reply, `"fail"` ends the
   * loop with the error.
   */
  onInvalidOutput?: "continue" | "restart" | "fail";
  /**
   * Ask again, unchanged, after a retryable provider error (a rate limit, a
   * 5xx) while attempts remain, waiting the provider's `retryAfter` first
   * (at most 30 s). Default `true`. A non-retryable error, a stop and the
   * deadline always end the loop.
   */
  retryErrors?: boolean;
  /**
   * Bounds each attempt: a call still answering after this long is stopped
   * and asked again, as a cut-off answer is (`cause: "timeout"`). For a model
   * that sometimes runs on repeating itself. Validation is not counted.
   */
  attemptTimeoutMs?: number;
  /**
   * Bounds the whole loop, every attempt and validation together; when it
   * runs out the result is `code: "timeout"`. The same as passing
   * `AbortSignal.timeout(ms)` alongside `signal`.
   */
  timeoutMs?: number;
  /**
   * Hears each attempt as it ends, passed or not: for a log line per attempt
   * with its duration and tokens. The same entries are on
   * `result.attemptLog`.
   */
  onAttempt?: (attempt: GenerateAttempt) => void;
}

type MaybePromise<T> = T | Promise<T>;

/** A problem `validate` reports. Falsy entries are dropped, so a checklist of
 *  `cond && "message"` can be returned as it is. */
export type GenerateProblem = string | false | null | undefined;

/** What `validate` returns. See `GenerateParams.validate`. */
export type GenerateVerdict<R> =
  | readonly GenerateProblem[]
  | { ok: true; value: R }
  | { ok: false; problems: readonly GenerateProblem[]; retry?: "continue" | "restart" | false }
  | void;

/** The second argument of `validate`. */
export interface GenerateValidateInfo {
  /** 1 for the first answer. */
  attempt: number;
  /** The most there will be. */
  attempts: number;
  /** The transcript with the answer being validated as its last message. */
  messages: AgentMessage[];
  /** Fires with the caller's `signal` or `timeoutMs`. Never fires otherwise. */
  signal: AbortSignal;
}

/** Why an attempt did not pass: `rejected` by `validate`, a schema mismatch,
 *  cut off at `maxOutputTokens`, or stopped by `attemptTimeoutMs`. */
export type GenerateFeedbackCause = "rejected" | "invalid_output" | "cut_off" | "timeout";

/** The second argument of `feedback`. */
export interface GenerateFeedbackInfo {
  /** The attempt that did not pass. */
  attempt: number;
  attempts: number;
  cause: GenerateFeedbackCause;
  /** The text is added to the same request (the reply was dropped), rather
   *  than sent as a new turn after it. */
  restart: boolean;
}

/** One attempt, on `result.attemptLog` and to `onAttempt`. */
export interface GenerateAttempt {
  /** 1 for the first. */
  attempt: number;
  /** `passed`; a cause from `GenerateFeedbackCause`; or `error` — the call
   *  failed (provider error, stop, deadline), and `error` says how. */
  outcome: "passed" | GenerateFeedbackCause | "error";
  /** From the call's start to its end, validation not included. */
  durationMs: number;
  /** This attempt's call alone; `result.usage` sums them. */
  usage: Usage;
  finishReason: FinishReason;
  /** What was sent back, when it did not pass for a reason the model can fix. */
  problems?: string[];
  error?: AgentRunFailure;
}

/** The last answer that parsed but `validate` rejected, and why. */
export interface GenerateRejection<Raw> {
  output: Raw;
  problems: string[];
}

/** The parts of a `GenerateResult` both arms have. */
interface GenerateOutcome {
  /**
   * The whole transcript: `messages` as given, the `prompt` as a user turn,
   * then the model's reply. On success the reply holds the value as an
   * `output` part; on a bad answer, the raw text the model wrote — so a retry
   * passes this straight back with a new `prompt` saying what was wrong.
   */
  messages: AgentMessage[];
  /** What the call cost, including when it failed — the tokens were billed. */
  usage: Usage;
  /** How the model call ended: `"stop"` on success, `"length"` for a cut-off
   *  answer, `"error"` or `"aborted"` when it did not finish. */
  finishReason: FinishReason;
  /** How many calls were made: 1 unless `attempts` allowed more. */
  attempts: number;
  /** Each call, in order: its outcome, duration and usage. */
  attemptLog: GenerateAttempt[];
}

/**
 * Discriminated on `ok`. `output` and `error` are each declared on both arms —
 * as `undefined` on the one where they cannot be — so that destructuring
 * `{ ok, output, error }` compiles, and checking `ok` narrows both.
 */
export type GenerateResult<O, Raw = O> =
  | GenerateSuccess<O>
  | (GenerateOutcome & {
      ok: false;
      /** The `AgentError`, plus the provider's HTTP `status` and `requestId`
       *  when the failure was a response from it — as on an agent run's
       *  `result().error`. When `validate` never passed it is
       *  `invalid_output` with the last problems in its message. */
      error: AgentRunFailure;
      output?: undefined;
      /** The last answer `validate` rejected, when one was: returned rather
       *  than thrown, for a caller that would rather keep a flawed answer
       *  than none. With `throwOnError` it is on the `AgentRunError`. */
      rejected?: GenerateRejection<Raw>;
    });

/** The `ok: true` arm of `GenerateResult`, and what `throwOnError` resolves. */
export type GenerateSuccess<O> = GenerateOutcome & {
  ok: true;
  /** The answer, or what `validate` turned it into. */
  output: O;
  error?: undefined;
  rejected?: undefined;
};
