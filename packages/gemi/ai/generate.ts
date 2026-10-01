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
export function generate<O extends Schema<any>>(
  params: GenerateParams<O> & { throwOnError: true },
): Promise<GenerateSuccess<Infer<O>>>;
export function generate<O extends Schema<any>>(
  params: GenerateParams<O>,
): Promise<GenerateResult<Infer<O>>>;
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
 * turn itself was stopped.
 */
export async function generateWithin(
  params: GenerateParams,
  hooks: { origin?: GenerateOrigin; settled?: (result: GenerateResult<unknown>) => void } = {},
): Promise<GenerateResult<unknown>> {
  // An id for the call, so the log line and an `AgentRunError` can be matched
  // up. `gen_` rather than `run_`: there is no run, and nothing is stored.
  const id = `gen_${crypto.randomUUID()}`;
  const result = await callModel(params);
  hooks.settled?.(result);
  if (!result.ok) {
    // A stop is an outcome the caller asked for, not a failure — the same rule
    // an agent run follows (an aborted run carries no `error` and is not
    // logged). A timeout is a failure: it reports `timeout`, as a run's
    // deadline does, and is logged.
    if (params.logErrors !== false && result.error.code !== "aborted") {
      logFailure(id, result.error, hooks.origin);
    }
    if (params.throwOnError) {
      throw new AgentRunError({
        runId: id,
        messages: result.messages,
        finishReason: result.finishReason,
        usage: result.usage,
        error: result.error,
      });
    }
  }
  return result;
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

async function callModel<O extends Schema<any>>(
  params: GenerateParams<O>,
): Promise<GenerateResult<Infer<O>>> {
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
            if (!error) reason = event.reason;
            break;
          case "error":
            reason = "error";
            error = event.error;
            detail = httpErrorDetail(event);
            break;
          // `tool-call-delta`, `tool-call` and `tool-search` cannot happen:
          // no tools were sent.
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
export interface GenerateParams<O extends Schema<any> = Schema<any>> {
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
}

/**
 * Discriminated on `ok`. `output` and `error` are each declared on both arms —
 * as `undefined` on the one where they cannot be — so that destructuring
 * `{ ok, output, error }` compiles, and checking `ok` narrows both.
 */
export type GenerateResult<O> =
  | GenerateSuccess<O>
  | (GenerateOutcome & {
      ok: false;
      /** The `AgentError`, plus the provider's HTTP `status` and `requestId`
       *  when the failure was a response from it — as on an agent run's
       *  `result().error`. */
      error: AgentRunFailure;
      output?: undefined;
    });

/** The `ok: true` arm of `GenerateResult`, and what `throwOnError` resolves. */
export type GenerateSuccess<O> = GenerateOutcome & { ok: true; output: O; error?: undefined };
