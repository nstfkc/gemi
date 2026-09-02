import type {
  AgentContentPart,
  AgentError,
  AgentMessage,
  AgentStreamEvent,
  AgentStreamFrame,
  FinishReason,
  NestedRun,
  PendingToolCall,
  ToolCallPart,
  ToolShapes,
} from "../types";

/**
 * Frames to a message list.
 *
 * The rule the whole file is built around: **a client may be handed any
 * suffix of a run, and may be handed the same frame twice.** An attached
 * stream starts mid-message, a reconnect replays from a cursor, and a proxy
 * that retries is entitled to deliver a frame again. So nothing here tracks
 * "the current message" — every event that touches a message names it, and a
 * message the list has never heard of is created on the spot rather than
 * dropped.
 *
 * The two mechanisms that make that work:
 *
 *   - `seq` guards replay. A frame at or below the state's cursor is a no-op,
 *     and `applyFrame` returns the *same object* so a caller can tell nothing
 *     happened. Without it a redelivered `text-delta` would append its text a
 *     second time — a bug that looks fine until someone refreshes.
 *   - a finished message is closed to further deltas. `seq` catches a redelivery
 *     within a run, but not a server that replays a run from zero to a client
 *     that already has the transcript; `message-end` is terminal, so a delta for
 *     a message that already carries a finish reason is replay by definition.
 *   - every mutation is either an append that the seq guard already protects,
 *     or an upsert keyed by an id. Tool calls and tool results arrive more than
 *     once (a call re-streams as its arguments grow), so those are keyed by
 *     `toolCallId`, never pushed blindly.
 *
 * A sub-agent's transcript is built by this same function calling itself. A
 * `nested-event` is unwrapped onto the `NestedRun` hanging off its parent's
 * tool-call part and handed to `reduce` again, so every rule above holds inside
 * a nested run for free — a nested `message-start` that never arrived, a
 * nested delta after a nested `message-end`, a nested `run-end` closing off a
 * message that never ended. Two levels of nesting cost this file nothing over
 * one, which is the whole reason the wire has a `nested-event` rather than a
 * second reducer.
 */

export type ChatState<T extends ToolShapes = ToolShapes, O = unknown> = {
  messages: AgentMessage<T, O>[];
  /** Non-empty exactly while the conversation is holding a question. */
  pending: PendingToolCall<T>[];
  error: AgentError | null;
  runId?: string;
  threadId?: string;
  /**
   * The highest frame applied. This is the cursor `/attach` is asked to resume
   * from, which is why it lives in the state a client keeps rather than in the
   * stream reader that dies with the connection.
   */
  seq: number;
  /**
   * Which run `seq` counts within.
   *
   * Separate from `runId`, which is cleared when the run ends because a UI asks
   * it whether anything is live. The cursor outlives the run it belongs to: a
   * frame from run_1 redelivered after run_1 finished is still a duplicate, and
   * without somewhere to remember that, replaying a finished run would look
   * exactly like the start of a new one.
   */
  cursorRunId?: string;
  /**
   * The messages the run in hand has touched, oldest first.
   *
   * `run-end` and `markAborted` both have to finish off a message whose
   * `message-end` never arrived, and "every assistant message with no finish
   * reason" is the wrong set to do it over: a superseded turn from an earlier
   * run is sitting in exactly that state, and stamping it with *this* run's
   * reason would relabel an interrupted answer as a clean completion. So the
   * reducer remembers which messages this run actually wrote to, and finishes
   * off only those. Reset by `run-start`; on a mid-run attach it simply fills
   * up from the first frame that names a message, which is the same set.
   */
  runMessageIds: string[];
  /**
   * The deferred tools the model has pulled in during this run, as a set.
   *
   * Not a message part, because a `tool-search` names no tool call and no
   * message — it happens *before* any call, which is exactly what makes it
   * worth showing ("looking for the right tool" instead of an unexplained
   * pause). So unlike `tool-progress` and `nested-event`, which now have a home
   * on the tool-call part, this one had nowhere in `AgentMessage` to go that
   * would not have meant inventing a content part in a frozen contract.
   *
   * A set, not a log: union is the only accumulation that survives redelivery
   * without a guard, and a client attached mid-run and handed a `tool-search`
   * it has already applied must not show the same tool twice. Run-scoped and
   * reset by `run-start` — it describes a run in progress, so it is deliberately
   * not something `initialChatState` restores.
   */
  loadedTools: string[];
  finishReason?: FinishReason;
};

export function initialChatState<T extends ToolShapes = ToolShapes, O = unknown>(
  init: {
    messages?: AgentMessage<T, O>[];
    pending?: PendingToolCall<T>[];
    threadId?: string;
    /** Where a restored client left off. `-1` means "I have seen nothing". */
    seq?: number;
    /**
     * Which run that `seq` counts within. A cursor without it is a number with
     * no units — frames number from zero in every run, so `seq: 10` means
     * nothing until you know whether the live run is the one that reached 10.
     */
    cursorRunId?: string;
  } = {},
): ChatState<T, O> {
  return {
    messages: init.messages ? [...init.messages] : [],
    pending: init.pending ? [...init.pending] : [],
    error: null,
    threadId: init.threadId,
    seq: init.seq ?? -1,
    cursorRunId: init.cursorRunId,
    runMessageIds: [],
    loadedTools: [],
  };
}

/**
 * Apply one frame.
 *
 * `now` is an argument rather than a `Date.now()` call so the reducer stays a
 * pure function of its inputs — it is only ever read when a frame arrives for a
 * message the list has not seen, which is precisely the mid-run-attach path a
 * test needs to pin down.
 */
export function applyFrame<T extends ToolShapes = ToolShapes, O = unknown>(
  state: ChatState<T, O>,
  frame: AgentStreamFrame<T, O>,
  now: string = new Date().toISOString(),
): ChatState<T, O> {
  // A `seq` is a position within *one* run, so the second turn of a
  // conversation numbers its frames from zero again and the cursor left over
  // from the first would silently swallow the whole answer. `run-start` naming
  // a run this state has not seen is the one frame entitled to drop the cursor.
  const startsNewRun = frame.event.type === "run-start" && frame.event.runId !== state.cursorRunId;
  // Identity, not a copy: the hook reads `next === prev` as "already applied"
  // and skips the callbacks that would otherwise fire twice.
  if (!startsNewRun && frame.seq <= state.seq) return state;
  return { ...reduce(state, frame.event, now), seq: frame.seq };
}

function reduce<T extends ToolShapes, O>(
  state: ChatState<T, O>,
  event: AgentStreamFrame<T, O>["event"],
  now: string,
): ChatState<T, O> {
  switch (event.type) {
    case "run-start":
      return {
        ...state,
        runId: event.runId,
        cursorRunId: event.runId,
        threadId: event.threadId ?? state.threadId,
        runMessageIds: [],
        loadedTools: [],
        finishReason: undefined,
      };

    case "message-start":
      return withMessage(state, event.messageId, now, (message) => ({
        ...message,
        role: event.role,
      }));

    // The two additive cases, and the only two that can double text. `seq`
    // catches an ordinary redelivery, but a client resuming with a cursor the
    // server ignores — or asked for the whole run when it already had the
    // transcript — gets frames it cannot recognise as duplicates. A finished
    // message is the one thing it can: `message-end` is terminal, so a delta
    // arriving for a message that already carries a finish reason is replay by
    // definition and appending it would show the answer twice.
    case "text-delta":
      if (isFinished(state, event.messageId)) return state;
      return withMessage(state, event.messageId, now, (message) => ({
        ...message,
        content: appendText(message.content, event.delta),
      }));

    case "reasoning-delta":
      if (isFinished(state, event.messageId)) return state;
      return withMessage(state, event.messageId, now, (message) => ({
        ...message,
        content: appendReasoning(message.content, event.delta),
      }));

    case "output-delta":
      // `snapshot` is the whole object so far, not an increment, so the raw
      // `delta` text is dropped here on purpose: replacing beats accumulating
      // when a client may have missed the first half of the JSON.
      return withMessage(state, event.messageId, now, (message) => ({
        ...message,
        content: upsert(
          message.content,
          { type: "output", value: event.snapshot as O, partial: true },
          (part) => part.type === "output",
        ),
      }));

    case "tool-call":
      // Keyed, because the same call re-streams as its arguments fill in — and
      // *merged* rather than replaced, which the plain upsert below cannot do.
      //
      // A `tool-call` frame is the model's half of the part. `progress` and
      // `nested` are the execution's half, and they arrive on events that name
      // no message, so a part that loses them cannot rebuild them from anything
      // later in the stream. Replacing wholesale is exactly how a run replayed
      // onto a transcript that already holds it drops a sub-agent's entire
      // transcript while appearing to converge.
      return withMessage(state, event.messageId, now, (message) => {
        const index = message.content.findIndex(
          (part) => part.type === "tool-call" && part.toolCallId === event.part.toolCallId,
        );
        const existing = index === -1 ? undefined : (message.content[index] as ToolCallPart<T>);
        // The frame wins where it says anything — a server that persists the
        // nested transcript and re-sends it is more authoritative than what this
        // client accumulated — and the part is kept where it does not.
        const progress = event.part.progress ?? existing?.progress;
        const nested = event.part.nested ?? existing?.nested;
        const part = {
          ...event.part,
          ...(progress ? { progress } : {}),
          ...(nested ? { nested } : {}),
        };
        const content = message.content.slice();
        if (index === -1) content.push(part);
        else content[index] = part;
        return { ...message, content };
      });

    case "tool-search": {
      // Accumulated as a set. Every other additive event in this file leans on
      // `seq` to survive redelivery; this one cannot, because a `tool-search`
      // carries no id at all — there is nothing to key an upsert on and nothing
      // to tell a second delivery from a second search. Union is what makes the
      // question moot: applying the same frame again is the same set, and two
      // genuinely different searches that both loaded `refundOrder` are, for a
      // UI naming the tools in play, the same fact twice.
      const loaded = event.loaded.filter((name) => !state.loadedTools.includes(name));
      if (loaded.length === 0) return state;
      return { ...state, loadedTools: [...state.loadedTools, ...loaded] };
    }

    case "tool-progress":
      // Append-only, exactly like a text delta, and protected the same two
      // ways: `seq` for redelivery within a run, and the finished-message check
      // inside `withToolCall` for a run replayed onto a transcript that already
      // holds it. The tool loop emits every yield before the message it belongs
      // to is finalised, so a progress datum for a finished message is replay
      // by definition — the same argument `text-delta` makes.
      return withToolCall(state, event.toolCallId, (part) => ({
        ...part,
        progress: [...(part.progress ?? []), event.data],
      }));

    case "nested-event": {
      // The recursion. The sub-run's transcript is an ordinary message list, so
      // it is reduced by this function rather than by a parallel one — which is
      // why an arbitrarily deep nesting is not a case handled here at all: an
      // inner `nested-event` simply lands back in this branch, one message list
      // further down.
      const nestedEvent = event as NestedEvent;
      return withToolCall(state, event.toolCallId, (part) => {
        const runs = part.nested ?? [];
        const index = runs.findIndex((run) => run.runId === nestedEvent.runId);
        // Created on the spot when unknown, for the same reason `withMessage`
        // creates a message it never saw start: a client attached mid-run gets
        // the sub-run's tail and no `run-start`, and dropping it would leave a
        // tool call that visibly does something looking like one that hangs.
        const run: NestedRun = runs[index] ?? {
          runId: nestedEvent.runId,
          agent: nestedEvent.agent,
          messages: [],
        };
        const next = applyNested(run, nestedEvent, now);
        const nested = index === -1 ? [...runs, next] : runs.map((r, i) => (i === index ? next : r));
        return { ...part, nested };
      });
    }

    case "tool-result": {
      const next = withMessage(state, event.messageId, now, (message) => ({
        ...message,
        content: upsert(
          message.content,
          event.part,
          (part) => part.type === "tool-result" && part.toolCallId === event.part.toolCallId,
        ),
      }));
      // A result is the answer to a pending call, whoever produced it — the
      // human here, or the server after an approval. Either way it is no longer
      // pending, and leaving it in the list would keep the UI asking.
      return {
        ...next,
        pending: next.pending.filter((call) => call.toolCallId !== event.part.toolCallId),
      };
    }

    case "awaiting-input":
      return { ...state, runId: event.runId, pending: [...event.pending] };

    case "message-end":
      return withMessage(state, event.messageId, now, (message) => ({
        ...message,
        finishReason: event.finishReason,
        content: message.content.map((part) =>
          part.type === "output" && part.partial ? { ...part, partial: false } : part,
        ),
      }));

    case "usage": {
      // The only event with no id of its own, so it goes on the last assistant
      // message — an assignment rather than an append, so a replay is harmless.
      //
      // The role test is the point. A run that counts its input tokens before
      // opening a message — one that errors early, or whose only output is a
      // tool call the client must resolve — emits `usage` while the last message
      // in the list is still the user's own optimistic turn, and token counts
      // rendered against what the user typed are simply false. With no assistant
      // message to hang it on, dropping it is the honest answer.
      //
      // Deliberately *not* narrowed to the messages this run touched: a client
      // resuming from a cursor mid-message has touched none of them yet, and
      // narrowing would make `usage` the one event that fails to converge from
      // an arbitrary cursor, which is the property the whole file is for.
      const index = lastIndexWhere(state.messages, (message) => message.role === "assistant");
      if (index === -1) return state;
      const messages = state.messages.slice();
      messages[index] = { ...messages[index]!, usage: event.usage };
      return { ...state, messages };
    }

    case "error":
      // Clearing `pending` here is what keeps "pending is non-empty exactly
      // when the UI is awaiting input" true: a run that errored is not holding
      // a question any more, it is holding a failure.
      return { ...state, error: event.error, pending: [] };

    case "run-end":
      return {
        ...state,
        runId: undefined,
        finishReason: event.finishReason,
        // A safety net for the client that attached late and never saw a
        // `message-end`: once the run is over nothing is still streaming, so a
        // message left without a finish reason would show a cursor forever.
        //
        // Scoped to this run's own messages. A turn superseded by a second send
        // is also sitting there unfinished, and it was *not* finished by this
        // run — stamping it "stop" would tell the user, and the model on the
        // next stateless turn, that an answer cut off mid-sentence ended
        // cleanly.
        messages: finishUnended(state, event.finishReason),
      };

    // Every event in the union is handled above, so this is reached only by a
    // server that speaks a newer protocol than this client. Kept as a silent
    // no-op rather than an exhaustiveness assertion for that reason: an old tab
    // meeting a new event must keep rendering the rest of the stream, and the
    // seq still advances so its cursor stays right.
    default:
      return state;
  }
}

/**
 * The interrupted turn, kept.
 *
 * `stop()` calls this before the server has said anything, because the point of
 * stopping is that the UI reacts now. Whatever the assistant had produced stays
 * in the list marked `aborted` — dropping it would lose text the user already
 * read, and would leave the transcript unable to say it was cut short.
 *
 * `pending` is untouched: a question the conversation is holding survives a
 * stopped run, and clearing it would silently discard the answer the user still
 * owes.
 */
export function markAborted<T extends ToolShapes = ToolShapes, O = unknown>(
  state: ChatState<T, O>,
): ChatState<T, O> {
  return {
    ...state,
    runId: undefined,
    finishReason: "aborted",
    // This run's messages only, for the same reason `run-end` is scoped: an
    // older turn that was already cut short is not cut short again by this one,
    // and a restored transcript may legitimately carry an unfinished message
    // that has nothing to do with the run being stopped.
    messages: finishUnended(state, "aborted"),
  };
}

// --- helpers -------------------------------------------------------------

/** The messages this run wrote, finished off with `reason` if they never ended. */
function finishUnended<T extends ToolShapes, O>(
  state: ChatState<T, O>,
  reason: FinishReason,
): AgentMessage<T, O>[] {
  return state.messages.map((message) =>
    message.role === "assistant" &&
    message.finishReason === undefined &&
    state.runMessageIds.includes(message.id)
      ? { ...message, finishReason: reason }
      : message,
  );
}

type NestedEvent = Extract<AgentStreamEvent, { type: "nested-event" }>;

/**
 * Run one update over the tool-call part with this id, wherever it lives.
 *
 * `tool-progress` and `nested-event` are the only events that name a tool call
 * without naming a message, so the message has to be found rather than told —
 * a scan from the newest end, because the call being worked on is the one that
 * just arrived.
 *
 * **A frame for a tool call this transcript does not have is dropped.** That is
 * the mid-run `/attach` case the whole file is written for, and it is the one
 * place the usual answer — create it on the spot — is the wrong one: a
 * `ToolCallPart` needs a tool `name` and an `input`, and neither is on these
 * events. Inventing them would put a tool call the model never made into the
 * transcript, under a name that is not a key of the agent's tools, which breaks
 * the narrowing that is the reason the shapes are carried into the browser at
 * all. So the progress is lost and the transcript stays true, rather than the
 * other way round.
 *
 * In practice a client that has the cursor has the part: `useChat` documents
 * `cursor` and `initialMessages` as things to persist together, and a client
 * that persisted one without the other is already the case that doubles text.
 * Parking the orphans until their tool call shows up was considered and is not
 * worth it — the call is *earlier* in the stream, never later, so nothing would
 * ever drain the parking lot.
 */
function withToolCall<T extends ToolShapes, O>(
  state: ChatState<T, O>,
  toolCallId: string,
  update: (part: ToolCallPart<T>) => ToolCallPart<T>,
): ChatState<T, O> {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i]!;
    const index = message.content.findIndex(
      (part) => part.type === "tool-call" && part.toolCallId === toolCallId,
    );
    if (index === -1) continue;
    // The replay guard, and the same one the deltas use. The tool loop runs
    // every tool before it finalises the message the calls sit in, so nothing
    // legitimately appends to a call inside a finished message; a frame that
    // does is a run being replayed onto a transcript that already has it, and
    // appending would show the progress log twice.
    if (message.finishReason !== undefined) return state;
    const content = message.content.slice();
    content[index] = update(content[index] as ToolCallPart<T>);
    const messages = state.messages.slice();
    messages[i] = { ...message, content };
    // Counted as a message this run touched, like every event that names one
    // directly — a client whose only frames for this message were nested ones
    // still needs `run-end` to close it, or it shows a cursor forever.
    const runMessageIds = state.runMessageIds.includes(message.id)
      ? state.runMessageIds
      : [...state.runMessageIds, message.id];
    return { ...state, runMessageIds, messages };
  }
  return state;
}

/**
 * One sub-run event, applied to the sub-run's own transcript.
 *
 * The sub-state is built and thrown away per event rather than kept, because
 * there is nowhere to keep it: `NestedRun` is a wire type and holds a
 * transcript, not a reducer state. Everything the inner `reduce` needs is
 * derivable from it.
 *
 *   - `seq` is `-1` and this calls `reduce`, not `applyFrame`. A nested event
 *     has no sequence of its own; it is numbered in the *parent's* stream, and
 *     the parent's cursor has already refused the duplicates.
 *   - `runMessageIds` is every message in the transcript, which for a nested
 *     run is exactly right and needs none of the parent's care. The parent
 *     scopes it because its list mixes runs; a `NestedRun` is keyed by `runId`
 *     and only ever written by events carrying that id, so every message in it
 *     belongs to the run that is ending.
 *   - `pending` is dropped. An escalated question reaches the user on the
 *     *parent's* `awaiting-input`, carrying the path that says which tool to
 *     re-enter; the copy inside the sub-run's own stream carries no path, so
 *     surfacing it would show the question twice and make one of them
 *     unanswerable.
 */
function applyNested(run: NestedRun, event: NestedEvent, now: string): NestedRun {
  const sub: ChatState = {
    messages: run.messages,
    pending: [],
    error: null,
    seq: -1,
    runMessageIds: run.messages.map((message) => message.id),
    loadedTools: [],
    finishReason: run.finishReason,
  };
  const next = reduce(sub, event.event, now);
  return {
    ...run,
    // A late label is still a label: `/attach` may deliver the sub-run's tail,
    // and every nested frame carries it.
    ...(event.label !== undefined ? { label: event.label } : {}),
    messages: next.messages,
    ...(next.finishReason !== undefined ? { finishReason: next.finishReason } : {}),
    // The sub-run's own total, lifted so a UI can price the block it is
    // rendering without walking its messages. An assignment, so redelivery is
    // harmless — the inner `reduce` has already put the same number on the
    // sub-run's last assistant message.
    ...(event.event.type === "usage" ? { usage: event.event.usage } : {}),
  };
}

function isFinished<T extends ToolShapes, O>(state: ChatState<T, O>, messageId: string) {
  const message = state.messages.find((candidate) => candidate.id === messageId);
  return message !== undefined && message.finishReason !== undefined;
}

function lastIndexWhere<M>(items: M[], match: (item: M) => boolean) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (match(items[i]!)) return i;
  }
  return -1;
}

function withMessage<T extends ToolShapes, O>(
  state: ChatState<T, O>,
  messageId: string,
  now: string,
  update: (message: AgentMessage<T, O>) => AgentMessage<T, O>,
): ChatState<T, O> {
  const index = state.messages.findIndex((message) => message.id === messageId);
  // Every id-carrying event marks its message as one this run touched, which is
  // what `run-end` and `markAborted` read to know whose loose ends are theirs.
  const runMessageIds = state.runMessageIds.includes(messageId)
    ? state.runMessageIds
    : [...state.runMessageIds, messageId];
  if (index === -1) {
    // The mid-stream attach. Every id-carrying event describes an assistant
    // message — `message-start` is the only event that declares a role and it
    // declares that one — so a placeholder is enough to hang the tail on.
    const blank: AgentMessage<T, O> = {
      id: messageId,
      role: "assistant",
      content: [],
      createdAt: now,
    };
    return { ...state, runMessageIds, messages: [...state.messages, update(blank)] };
  }
  const messages = state.messages.slice();
  messages[index] = update(messages[index]!);
  return { ...state, runMessageIds, messages };
}

function appendText<T extends ToolShapes, O>(
  content: AgentContentPart<T, O>[],
  delta: string,
): AgentContentPart<T, O>[] {
  const last = content[content.length - 1];
  // Coalesced into the trailing text part, but only if it *is* trailing: a
  // delta after a tool call opens a new part, which is what lets a UI render
  // "thinking / call / answer" in the order it happened.
  if (last && last.type === "text") {
    return [...content.slice(0, -1), { type: "text", text: last.text + delta }];
  }
  return [...content, { type: "text", text: delta }];
}

function appendReasoning<T extends ToolShapes, O>(
  content: AgentContentPart<T, O>[],
  delta: string,
): AgentContentPart<T, O>[] {
  const last = content[content.length - 1];
  if (last && last.type === "reasoning") {
    return [...content.slice(0, -1), { ...last, text: (last.text ?? "") + delta }];
  }
  return [...content, { type: "reasoning", text: delta }];
}

function upsert<T extends ToolShapes, O>(
  content: AgentContentPart<T, O>[],
  part: AgentContentPart<T, O>,
  match: (part: AgentContentPart<T, O>) => boolean,
): AgentContentPart<T, O>[] {
  const index = content.findIndex(match);
  if (index === -1) return [...content, part];
  const next = content.slice();
  next[index] = part;
  return next;
}
