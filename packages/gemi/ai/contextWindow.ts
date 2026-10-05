/**
 * Bounding what a long thread sends to the model (#473).
 *
 * A threaded conversation grows without end, and before this nothing in gemi
 * bounded what a turn sent: the whole `loadThread` went to the provider until
 * it answered `context_length_exceeded`. These are the pieces an app needs to
 * bound it where the model call is, rather than in its store:
 *
 * - `turnStarts` / `splitTurns`: where the user's turns begin. A cut made at
 *   one never separates a tool call from its result, since a result is stored
 *   in the message that made the call, and never strands a tool-injected file
 *   message (user role, but not a turn) from the call that showed it.
 * - `windowMessages`: a built-in policy over those turns (at most N turns, at
 *   most N bytes or approximate tokens), with cut points that move in steps so
 *   the provider's prompt cache keeps hitting.
 *
 * `Agent.create({ contextWindow })` applies the policy on every model call, and
 * `prepareStep` is the hook for anything else. Neither changes what is stored:
 * they shape the request, and the run's history, `onMessage` and the store
 * see every message as before.
 */

import type { ContextCompactOptions } from "./contextCompaction";
import type { AgentMessage, ToolCallPart, ToolSearchRecord } from "./types";

/**
 * The ids of the messages a tool injected to show a file, read from the
 * `ToolCallPart.attachments` records in `messages`.
 *
 * The record is the test, not `attachmentId` on the part: a user's own upload
 * carries an `attachmentId` too. Such a message has the user's role but is not
 * the user's turn, which is why `turnStarts` steps over it.
 */
export function injectedMessageIds(messages: readonly AgentMessage[]): Set<string> {
  const injected = new Set<string>();
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== "tool-call") continue;
      for (const record of part.attachments ?? []) {
        if (record && "shown" in record && record.shown) injected.add(record.shown.messageId);
      }
    }
  }
  return injected;
}

/**
 * The index of the first message of every turn in `messages`.
 *
 * A turn starts at a user message that no tool injected, and runs until the
 * next one: the assistant's steps, their tool calls with their results (which
 * are stored on the same message as the call), and any file a tool showed.
 * Index 0 always starts a turn, so messages before the first user message (a
 * greeting, a run cut short before its turn was stored) belong to the first
 * turn rather than to none. Empty for an empty list.
 */
export function turnStarts(messages: readonly AgentMessage[]): number[] {
  if (messages.length === 0) return [];
  const injected = injectedMessageIds(messages);
  const starts = [0];
  for (let index = 1; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "user" && !injected.has(message.id)) starts.push(index);
  }
  return starts;
}

/** `messages` grouped into turns. See `turnStarts`. */
export function splitTurns(messages: readonly AgentMessage[]): AgentMessage[][] {
  const starts = turnStarts(messages);
  return starts.map((start, index) => messages.slice(start, starts[index + 1] ?? messages.length));
}

/**
 * Roughly how much a message costs to send: the length of its JSON. A file
 * part counts as its reference, not its bytes, which is what the request
 * carries. Good enough to budget with, and the same number for the same
 * message every time, which is what keeps a cut point stable.
 */
export function messageSize(message: AgentMessage): number {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 0;
  }
}

/** Characters per token when a budget is given in `maxTokens`. */
const CHARS_PER_TOKEN = 4;

/** `ContextWindowOptions.step`'s default. */
export const DEFAULT_CONTEXT_WINDOW_STEP = 10;

/** `ContextWindowOptions.note`'s default. */
export const DEFAULT_CONTEXT_WINDOW_NOTE = "[Earlier turns of this conversation are not shown.]";

export type ContextWindowOptions = {
  /** The most turns sent. The latest turn is always sent, whatever the limits. */
  maxTurns?: number;
  /**
   * The most characters of message JSON sent (see `messageSize`). The system
   * prompt and the tools' schemas are not counted.
   */
  maxBytes?: number;
  /**
   * The same budget in approximate tokens (four characters each). When both
   * are given, the smaller one applies.
   */
  maxTokens?: number;
  /**
   * How many turns the start of the window moves at a time. Default 10.
   *
   * A window that slid one turn per turn would send a different first message
   * on every turn, and the provider's prompt cache (a prefix cache) would miss
   * on every turn. With a step, the first kept turn is the 0th, the 10th, the
   * 20th, … of the thread, so consecutive turns send the same prefix until the
   * window has to move again. The cost is that the window holds up to `step`
   * fewer turns than the limits would allow. `1` slides one turn at a time.
   */
  step?: number;
  /**
   * Put at the start of the first kept turn when turns were left out, so the
   * model knows the conversation goes back further. Default
   * `DEFAULT_CONTEXT_WINDOW_NOTE`; `false` for none. A function gets how much
   * was left out and answers the text, or `false`.
   */
  note?: string | false | ((omitted: { turns: number; messages: number }) => string | false);
  /**
   * Summarise the turns left out instead of dropping them (#782). Off unless
   * set; `true` uses the defaults. Applies to a run with a `threadId` (a
   * stored thread), at the top level; anything else, stateless threads
   * included, gets the plain window. `windowMessages` itself ignores it. See
   * `ContextCompactOptions`.
   *
   * Turns are summarised when the window leaves them out and, with
   * `compact.triggerTokens`, once the turns sent would be over that many
   * tokens. The summary is made with one or more provider calls when the
   * window's start moves (every `step` turns), usually in the background
   * after the turn before; kept per thread in a `SummaryStore`; and sent as a
   * user message in front of the kept turns, in place of `note`. Its usage is
   * billed once, to a run that waits on it or uses it. If it fails, the run
   * sends the plain window with `note`.
   */
  compact?: boolean | ContextCompactOptions;
};

export type ContextWindowResult = {
  /** What to send. New objects only where something changed (the note, a
   *  carried search); every other message is the one passed in. */
  messages: AgentMessage[];
  /** The index in the input of the first kept turn's first message. */
  start: number;
  /** How many turns and messages were left out. Both 0 when nothing was. */
  omittedTurns: number;
  omittedMessages: number;
};

/**
 * The latest turns of `messages` that fit `options`.
 *
 * - Cuts only at a turn start (`turnStarts`), so a tool call keeps its result
 *   and a tool-injected file stays below the call that showed it.
 * - Always keeps the latest turn, even when it alone is over the budget: an
 *   empty request is worse than an oversized one, and the provider is the
 *   judge of whether it fits.
 * - Moves the cut `step` turns at a time, counted from the thread's first
 *   turn, so the prefix sent stays the same from turn to turn (see `step`).
 *   When no step-aligned cut fits (one huge turn), it falls back to the
 *   earliest turn that does.
 * - Keeps `system` messages from before the cut, at the front: they are
 *   instructions, not conversation.
 * - Carries tool searches over the cut (#777). A namespaced or deferred tool
 *   is only loaded for the model by a search in its history, so a kept call to
 *   one whose search was left out gets that search put back on it (on a copy).
 *
 * Pure: the input is never changed, and the same input gives the same output.
 */
export function windowMessages(
  messages: readonly AgentMessage[],
  options: ContextWindowOptions = {},
): ContextWindowResult {
  const all = [...messages];
  const starts = turnStarts(all);
  const budget = byteBudget(options);
  const maxTurns = positive(options.maxTurns) ?? Infinity;
  const step = Math.max(1, Math.floor(positive(options.step) ?? DEFAULT_CONTEXT_WINDOW_STEP));

  if (starts.length <= 1 || (maxTurns >= starts.length && budget === Infinity)) {
    return { messages: all, start: 0, omittedTurns: 0, omittedMessages: 0 };
  }

  // Characters from each message to the end: what a cut there would send.
  // System messages kept from before the cut are not counted.
  const sizeFrom: number[] = Array.from({ length: all.length + 1 }, () => 0);
  if (budget !== Infinity) {
    for (let index = all.length - 1; index >= 0; index--) {
      sizeFrom[index] = sizeFrom[index + 1]! + messageSize(all[index]!);
    }
  }
  const fits = (turn: number) =>
    starts.length - turn <= maxTurns && sizeFrom[starts[turn]!]! <= budget;

  let first = -1;
  for (let turn = 0; turn < starts.length; turn += step) {
    if (fits(turn)) {
      first = turn;
      break;
    }
  }
  if (first < 0) {
    for (let turn = 0; turn < starts.length; turn++) {
      if (fits(turn)) {
        first = turn;
        break;
      }
    }
  }
  if (first < 0) first = starts.length - 1;
  if (first === 0) return { messages: all, start: 0, omittedTurns: 0, omittedMessages: 0 };

  const start = starts[first]!;
  const dropped = all.slice(0, start);
  const pinned = dropped.filter((message) => message.role === "system");
  const kept = carrySearches(dropped, all.slice(start));

  const omitted = { turns: first, messages: dropped.length - pinned.length };
  const note =
    typeof options.note === "function"
      ? options.note(omitted)
      : options.note === undefined
        ? DEFAULT_CONTEXT_WINDOW_NOTE
        : options.note;
  if (note) {
    const head = kept[0]!;
    kept[0] = { ...head, content: [{ type: "text", text: note }, ...head.content] };
  }

  return {
    messages: [...pinned, ...kept],
    start,
    omittedTurns: omitted.turns,
    omittedMessages: omitted.messages,
  };
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function byteBudget(options: ContextWindowOptions): number {
  const bytes = positive(options.maxBytes) ?? Infinity;
  const tokens = positive(options.maxTokens);
  return Math.min(bytes, tokens === undefined ? Infinity : tokens * CHARS_PER_TOKEN);
}

/**
 * What a search has to have loaded for a call to make sense: the call's
 * namespace, or, for a deferred tool outside any namespace, its name.
 */
function covers(search: ToolSearchRecord, call: ToolCallPart): boolean {
  const namespaces = Array.isArray(search?.namespaces) ? search.namespaces : [];
  const loaded = Array.isArray(search?.loaded) ? search.loaded : [];
  return call.namespace ? namespaces.includes(call.namespace) : loaded.includes(String(call.name));
}

function searchesOf(part: ToolCallPart): ToolSearchRecord[] {
  return Array.isArray(part.toolSearches) ? part.toolSearches : [];
}

/**
 * `kept`, with the searches from `dropped` that a kept call still depends on
 * put back on the first call that needs one.
 *
 * A call needs a dropped search when no search before it in `kept` (its own
 * included) covers it and one in `dropped` does. All such searches go on the
 * first call that needs any, in their original order, so every later call is
 * covered by them too. Deterministic in the cut, which keeps the prefix the
 * same from turn to turn while the cut stays put.
 */
function carrySearches(dropped: AgentMessage[], kept: AgentMessage[]): AgentMessage[] {
  const droppedSearches: ToolSearchRecord[] = [];
  for (const message of dropped) {
    for (const part of message.content ?? []) {
      if (part.type === "tool-call") droppedSearches.push(...searchesOf(part));
    }
  }
  if (droppedSearches.length === 0) return kept;

  const seen: ToolSearchRecord[] = [];
  const needed = new Set<ToolSearchRecord>();
  let host: { message: number; part: number } | undefined;
  kept.forEach((message, m) => {
    (message.content ?? []).forEach((part, p) => {
      if (part.type !== "tool-call" || part.partial) return;
      seen.push(...searchesOf(part));
      if (seen.some((search) => covers(search, part))) return;
      const missing = droppedSearches.filter((search) => covers(search, part));
      if (missing.length === 0) return;
      for (const search of missing) needed.add(search);
      host ??= { message: m, part: p };
    });
  });
  if (!host) return kept;

  const carried = droppedSearches.filter((search) => needed.has(search));
  const out = [...kept];
  const message = out[host.message]!;
  out[host.message] = {
    ...message,
    content: message.content.map((part, p) =>
      p === host!.part && part.type === "tool-call"
        ? { ...part, toolSearches: [...carried, ...searchesOf(part)] }
        : part,
    ),
  };
  return out;
}
