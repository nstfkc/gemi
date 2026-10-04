/**
 * Compaction for the context window (#782).
 *
 * `contextWindow` (#473) bounds a long thread's request by leaving its older
 * turns out. With `compact` set, the turns left out are summarised instead,
 * and the request becomes `[system messages, summary, ...kept turns]`.
 *
 * - **Incremental.** The part left out of a long thread can itself be bigger
 *   than a context, so a summary is never built from the whole of it at once.
 *   The summary for a cut is the summary for an earlier cut of the same thread
 *   plus the turns between the two, folded in chunks of at most `chunkTokens`.
 * - **Persistent.** Summaries live in a `SummaryStore`, per thread and keyed
 *   by the cut (the id of the first kept message). `AgentController` uses its
 *   own `AgentStore` when that implements the summary methods, which
 *   `MemoryAgentStore` does; otherwise a process-wide memory store.
 * - **Computed once per cut.** The cut moves `step` turns at a time, so a
 *   summary is made when the window moves and reused, from the store, by every
 *   later turn until it moves again. The request's prefix stays the same from
 *   turn to turn in between, so the provider's prompt cache keeps hitting.
 * - **Never twice at once.** In one process, concurrent runs on a thread share
 *   one summary call per cut. Across processes, a store may implement
 *   `lockSummary`; a run that finds the cut locked waits for the summary to
 *   appear, and sends the plain window if it doesn't in time.
 * - **Billed to the run.** Each summary call's usage is added to the run's.
 * - **Never fatal.** A failed summary call sends the plain window with its
 *   note, as `contextWindow` without `compact` would, and the run goes on.
 *
 * The summary is checked against what it summarised: each record carries a
 * fingerprint of the messages before its cut, so a thread whose earlier
 * messages changed (a regenerate, an edit, an amended tool result) gets a new
 * summary rather than a stale one.
 */

import type { AgentProvider } from "./AgentProvider";
import { turnStarts, windowMessages } from "./contextWindow";
import type { ContextWindowOptions } from "./contextWindow";
import { generate } from "./generate";
import { addUsage, emptyUsage } from "./runtime";
import { s } from "./Schema";
import type { AgentMessage, AgentContentPart, Usage } from "./types";

/** `ContextCompactOptions.maxSummaryTokens`'s default. */
export const DEFAULT_MAX_SUMMARY_TOKENS = 1_000;
/** `ContextCompactOptions.chunkTokens`'s default. */
export const DEFAULT_COMPACT_CHUNK_TOKENS = 24_000;
/** `ContextCompactOptions.lockWaitMs`'s default. */
export const DEFAULT_COMPACT_LOCK_WAIT_MS = 20_000;

/** `ContextCompactOptions.instructions`'s default. */
export const DEFAULT_COMPACT_INSTRUCTIONS = [
  "You keep a running summary of a conversation between a user and an AI assistant.",
  "The assistant will continue the conversation with only your summary and the latest turns, so the summary has to carry everything from the earlier turns it may still need.",
  "You are given the summary so far (possibly empty) and the turns that came after it. Answer the updated summary, which replaces the old one.",
  "Keep: the user's goals, preferences and constraints; decisions made and why; facts, names, ids, numbers, dates, file names and URLs that may matter later; what tools were used and their important results; open questions and unfinished work.",
  "Drop greetings, repetition and anything later turns superseded. Do not invent anything, and do not answer the user.",
  "Write terse prose or bullet points, in the language of the conversation.",
].join(" ");

/** The text the summary is sent under. */
export const COMPACT_SUMMARY_HEADER =
  "[Summary of the earlier turns of this conversation, which are not shown:]";

/**
 * `contextWindow.compact`: summarise the turns the window leaves out instead
 * of dropping them. See `contextCompaction.ts`.
 */
export type ContextCompactOptions = {
  /** The model that writes the summaries. Default: the run's provider. */
  provider?: AgentProvider;
  /** The summariser's system prompt. Default `DEFAULT_COMPACT_INSTRUCTIONS`. */
  instructions?: string;
  /**
   * How long a summary may be, in approximate tokens. Default 1000. The model
   * is asked for at most this, a longer answer is cut to it, and it is
   * reserved from the window's `maxTokens`/`maxBytes`, so the summary and the
   * kept turns together stay within the budget.
   */
  maxSummaryTokens?: number;
  /**
   * The most transcript one summary call is sent, in approximate tokens.
   * Default 24000. More turns than this to fold in (the first summary of a
   * long thread) take several calls, each building on the last.
   */
  chunkTokens?: number;
  /** Passed to the summary call. Default `"low"`; dropped by a model that
   *  cannot reason. */
  reasoning?: "minimal" | "low" | "medium" | "high";
  /**
   * Where the summaries live. Default: the controller's `AgentStore` when it
   * implements `loadSummaries` and `saveSummary` (as `MemoryAgentStore` does),
   * else `defaultSummaryStore`, which lasts as long as the process.
   */
  store?: SummaryStore;
  /**
   * How long a run waits for a summary another process is writing (see
   * `SummaryStore.lockSummary`) before it sends the plain window instead.
   * Default 20000.
   */
  lockWaitMs?: number;
};

/** One summary of a thread's turns before a cut. */
export type ThreadSummary = {
  /** The id of the first message after the summarised part: the cut. */
  cutMessageId: string;
  /** The summary, without `COMPACT_SUMMARY_HEADER`. */
  text: string;
  /** How many turns and messages before the cut it covers. */
  turns: number;
  messages: number;
  /**
   * A hash of the messages it covers, as stored. A record whose fingerprint
   * no longer matches the thread is ignored.
   */
  fingerprint: string;
  createdAt: string;
  /** What the calls that wrote it cost. */
  usage?: Usage;
};

/**
 * Where `compact` keeps its summaries. `AgentStore` has the same optional
 * methods, so a store that holds threads can hold their summaries too, and
 * drop them with the thread.
 */
export interface SummaryStore {
  /**
   * The thread's summaries, in any order. Keeping a few per thread is enough:
   * the latest is what the next cut builds on, and an older one only helps
   * when the window moves back (a regenerate, a larger budget).
   */
  loadSummaries(threadId: string): Promise<ThreadSummary[]>;
  /** Upsert by `cutMessageId`. */
  saveSummary(threadId: string, summary: ThreadSummary): Promise<void>;
  /**
   * Optional, for a store shared by several processes: take the lock for one
   * cut of a thread for at most `ttlMs`, answering its release, or `null` when
   * another process holds it. (Redis: `SET key NX PX ttlMs`.) Without it, two
   * processes may both summarise the same cut once; one process never does.
   */
  lockSummary?(
    threadId: string,
    cutMessageId: string,
    ttlMs: number,
  ): Promise<(() => Promise<void>) | null>;
}

/** How many summaries `MemorySummaryStore` keeps per thread. */
const SUMMARIES_PER_THREAD = 8;

/**
 * Summaries kept per thread in memory, most recent first. Lost on restart and
 * not shared between processes, like `MemoryAgentStore`. Threads are
 * forgotten after `ttlMs` without a read or a write.
 */
export class MemorySummaryStore implements SummaryStore {
  private threads = new Map<string, { summaries: ThreadSummary[]; touchedAt: number }>();
  private lastSweep = 0;

  constructor(readonly ttlMs = 24 * 60 * 60 * 1000) {}

  async loadSummaries(threadId: string): Promise<ThreadSummary[]> {
    this.sweep();
    const entry = this.threads.get(threadId);
    if (!entry) return [];
    entry.touchedAt = Date.now();
    return entry.summaries.slice();
  }

  async saveSummary(threadId: string, summary: ThreadSummary): Promise<void> {
    this.sweep();
    const entry = this.threads.get(threadId) ?? {
      summaries: [],
      touchedAt: Date.now(),
    };
    entry.summaries = keepSummary(entry.summaries, summary);
    entry.touchedAt = Date.now();
    this.threads.set(threadId, entry);
  }

  /** Forget a thread's summaries. */
  delete(threadId: string): void {
    this.threads.delete(threadId);
  }

  private sweep(now = Date.now()): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [threadId, entry] of this.threads) {
      if (now - entry.touchedAt > this.ttlMs) this.threads.delete(threadId);
    }
  }
}

/**
 * `summaries` with `summary` put first, any older record for the same cut
 * replaced, and at most `SUMMARIES_PER_THREAD` kept. For stores that hold a
 * thread's summaries as a list.
 */
export function keepSummary(summaries: readonly ThreadSummary[], summary: ThreadSummary) {
  return [summary, ...summaries.filter((held) => held.cutMessageId !== summary.cutMessageId)].slice(
    0,
    SUMMARIES_PER_THREAD,
  );
}

/** The process-wide summary store a run uses when nothing else is given. */
export const defaultSummaryStore = new MemorySummaryStore();

/** Whether `store` holds summaries (an `AgentStore` may or may not). */
export function isSummaryStore(store: unknown): store is SummaryStore {
  const candidate = store as Partial<SummaryStore> | null | undefined;
  return (
    typeof candidate?.loadSummaries === "function" && typeof candidate?.saveSummary === "function"
  );
}

// --- the request -----------------------------------------------------------

export type CompactParams = {
  /** What the request would send before windowing (`historyForProvider`). */
  history: AgentMessage[];
  /** The same messages as stored, index for index, for the fingerprint. */
  stored: readonly AgentMessage[];
  window: ContextWindowOptions;
  compact: ContextCompactOptions;
  threadId: string;
  /** The run's provider, used when `compact.provider` is not set. */
  provider: AgentProvider;
  store: SummaryStore;
  signal: AbortSignal;
  /** Told the usage of every summary call, failed ones included. */
  onUsage: (usage: Usage) => void;
  /**
   * The run's own memo, by cut: the messages before the cut don't change
   * between a run's steps, so later steps skip the fingerprint and the store,
   * and a summary that failed is not tried again on every step.
   */
  memo?: Map<string, ThreadSummary | null>;
};

/**
 * The messages a compacted window sends: the window with the summary of what
 * it left out in front, or the plain window (with its note) when there is
 * nothing to summarise or the summary could not be made.
 */
export async function compactWindow(params: CompactParams): Promise<AgentMessage[]> {
  const { history, window, compact } = params;
  const maxSummaryTokens = positiveInt(compact.maxSummaryTokens) ?? DEFAULT_MAX_SUMMARY_TOKENS;
  // The summary is sent too, so it comes out of the budget. Never down to 0,
  // which `windowMessages` would read as "no limit".
  const reserved: ContextWindowOptions = {
    ...window,
    ...(positiveInt(window.maxTokens)
      ? { maxTokens: Math.max(1, window.maxTokens! - maxSummaryTokens) }
      : {}),
    ...(positiveInt(window.maxBytes)
      ? {
          maxBytes: Math.max(1, window.maxBytes! - maxSummaryTokens * CHARS_PER_TOKEN),
        }
      : {}),
  };
  const plain = () => windowMessages(history, reserved).messages;

  const cut = windowMessages(history, { ...reserved, note: false });
  if (cut.omittedTurns === 0) return cut.messages;

  const memoKey = `${history[cut.start]!.id}:${cut.start}`;
  let summary: ThreadSummary | null | undefined = params.memo?.get(memoKey);
  if (summary === undefined) {
    try {
      summary = await summaryFor(params, cut.start, maxSummaryTokens);
    } catch (error) {
      if (params.signal.aborted) throw error;
      summary = null;
    }
    // Not when the run was stopped: that is no verdict on the summary.
    if (!params.signal.aborted) params.memo?.set(memoKey, summary);
  }
  if (!summary) return plain();

  const keptCount = history.length - cut.start;
  const pinned = cut.messages.slice(0, cut.messages.length - keptCount);
  const kept = cut.messages.slice(cut.messages.length - keptCount);
  const head = history[cut.start]!;
  return [
    ...pinned,
    {
      // Derived from the cut, so the same cut sends the same message: the
      // prompt cache keys on the bytes.
      id: `summary_${head.id}`,
      role: "user",
      content: [{ type: "text", text: `${COMPACT_SUMMARY_HEADER}\n${summary.text}` }],
      createdAt: head.createdAt,
    },
    ...kept,
  ];
}

/** Summary calls in flight in this process, by thread and cut. */
const inFlight = new Map<string, Promise<ThreadSummary | null>>();

async function summaryFor(
  params: CompactParams,
  start: number,
  maxSummaryTokens: number,
): Promise<ThreadSummary | null> {
  const { history, stored, threadId, store } = params;
  const cutMessageId = history[start]!.id;
  const fingerprints = prefixFingerprints(stored, start);
  const fingerprint = fingerprints[start]!;
  const matches = (summary: ThreadSummary | undefined) =>
    summary?.cutMessageId === cutMessageId && summary.fingerprint === fingerprint;

  const found = (await load(store, threadId)).find(matches);
  if (found) return found;

  const key = `${threadId}\u0000${cutMessageId}\u0000${fingerprint}`;
  const running = inFlight.get(key);
  if (running) return running;

  const work = (async () => {
    const lockWaitMs = positiveInt(params.compact.lockWaitMs) ?? DEFAULT_COMPACT_LOCK_WAIT_MS;
    let release: (() => Promise<void>) | null = null;
    if (store.lockSummary) {
      try {
        release = await store.lockSummary(threadId, cutMessageId, lockWaitMs + 60_000);
      } catch {
        release = null;
      }
      if (!release) return waitFor(params, matches, lockWaitMs);
    }
    try {
      // Again under the lock: whoever held it may have just written it.
      const summaries = await load(store, threadId);
      const again = summaries.find(matches);
      if (again) return again;
      return await build(params, summaries, fingerprints, start, maxSummaryTokens);
    } finally {
      if (release) await release().catch(() => {});
    }
  })();
  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

async function load(store: SummaryStore, threadId: string): Promise<ThreadSummary[]> {
  try {
    const summaries = await store.loadSummaries(threadId);
    return Array.isArray(summaries) ? summaries.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is ThreadSummary {
  const record = value as ThreadSummary | null;
  return (
    !!record &&
    typeof record.cutMessageId === "string" &&
    typeof record.text === "string" &&
    typeof record.fingerprint === "string"
  );
}

/** Another process holds the cut's lock: wait for its summary to land. */
async function waitFor(
  params: CompactParams,
  matches: (summary: ThreadSummary | undefined) => boolean,
  waitMs: number,
): Promise<ThreadSummary | null> {
  const until = Date.now() + waitMs;
  while (Date.now() < until && !params.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const found = (await load(params.store, params.threadId)).find(matches);
    if (found) return found;
  }
  return null;
}

/**
 * Folds the turns before `start` into a summary, from the latest still-valid
 * summary at an earlier cut (or from nothing), and saves it.
 */
async function build(
  params: CompactParams,
  summaries: ThreadSummary[],
  fingerprints: string[],
  start: number,
  maxSummaryTokens: number,
): Promise<ThreadSummary | null> {
  const { history, compact } = params;
  const starts = turnStarts(history);
  const startTurn = starts.indexOf(start);

  // The base: the latest summary whose cut is a turn start before this one
  // and whose fingerprint still matches the thread up to it.
  const indexOf = new Map(starts.map((index) => [history[index]!.id, index]));
  let base: ThreadSummary | undefined;
  let from = 0;
  for (const summary of summaries) {
    const at = indexOf.get(summary.cutMessageId);
    if (at === undefined || at >= start || at <= from) continue;
    if (summary.fingerprint !== fingerprints[at]) continue;
    base = summary;
    from = at;
  }

  const chunkChars =
    (positiveInt(compact.chunkTokens) ?? DEFAULT_COMPACT_CHUNK_TOKENS) * CHARS_PER_TOKEN;
  const chunks = chunkTurns(history, starts, from, start, chunkChars);
  const maxChars = maxSummaryTokens * CHARS_PER_TOKEN;
  const instructions = `${compact.instructions ?? DEFAULT_COMPACT_INSTRUCTIONS} Keep the summary under about ${Math.round(maxSummaryTokens * 0.75)} words.`;

  let text = base?.text ?? "";
  let usage = emptyUsage();
  for (const chunk of chunks) {
    const result = await generate({
      provider: compact.provider ?? params.provider,
      instructions,
      prompt: `Summary so far:\n${text || "(none yet: these are the first turns of the conversation)"}\n\nThe turns that came after it:\n${chunk}`,
      output: s.object({ summary: s.string() }),
      reasoning: compact.reasoning ?? "low",
      signal: params.signal,
    });
    usage = addUsage(usage, result.usage);
    params.onUsage(result.usage);
    if (!result.ok) return null;
    text = truncate(result.output.summary.trim(), maxChars);
  }
  if (!text) return null;

  const summary: ThreadSummary = {
    cutMessageId: history[start]!.id,
    text,
    turns: startTurn < 0 ? 0 : startTurn,
    messages: start,
    fingerprint: fingerprints[start]!,
    createdAt: new Date().toISOString(),
    usage,
  };
  try {
    await params.store.saveSummary(params.threadId, summary);
  } catch {
    // Sent this time anyway; the next turn writes it again.
  }
  return summary;
}

// --- the transcript ----------------------------------------------------------

const CHARS_PER_TOKEN = 4;

/**
 * The turns from `from` to `to` (message indexes, both turn starts) rendered
 * as text, in chunks of whole turns of at most `chunkChars` each. A turn on
 * its own over the limit is its own chunk, its parts cut short.
 */
export function chunkTurns(
  history: readonly AgentMessage[],
  starts: readonly number[],
  from: number,
  to: number,
  chunkChars: number,
): string[] {
  const injected = new Set<string>();
  const startSet = new Set(starts);
  for (let i = 0; i < history.length; i++) {
    if (history[i]!.role === "user" && !startSet.has(i) && i !== 0) injected.add(history[i]!.id);
  }
  const partLimit = Math.max(500, Math.min(20_000, Math.floor(chunkChars / 2)));

  const chunks: string[] = [];
  let current = "";
  const bounds = starts.filter((index) => index >= from && index < to);
  bounds.forEach((turnStart, t) => {
    const turnEnd = bounds[t + 1] ?? to;
    const lines: string[] = [];
    for (let i = turnStart; i < turnEnd; i++) {
      const line = renderMessage(history[i]!, injected.has(history[i]!.id), partLimit);
      if (line) lines.push(line);
    }
    const turn = lines.join("\n");
    if (!turn) return;
    if (current && current.length + turn.length + 2 > chunkChars) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${turn}` : turn;
  });
  if (current) chunks.push(current);
  return chunks;
}

function renderMessage(message: AgentMessage, injected: boolean, limit: number): string {
  // System messages before the cut are still sent, at the front.
  if (message.role === "system") return "";
  const who = injected ? "Tool (file shown)" : message.role === "user" ? "User" : "Assistant";
  const parts = (message.content ?? []).map((part) => renderPart(part, limit)).filter(Boolean);
  return parts.length > 0 ? `${who}: ${parts.join("\n")}` : "";
}

function renderPart(part: AgentContentPart, limit: number): string {
  switch (part.type) {
    case "text":
      return truncate(part.text ?? "", limit);
    case "file":
      return `[file: ${part.name ?? part.mimeType ?? part.fileId ?? "attachment"}]`;
    case "tool-call": {
      const name = part.namespace ? `${part.namespace}.${String(part.name)}` : String(part.name);
      return `[called ${name}(${truncate(json(part.input), Math.min(limit, 1_000))})]`;
    }
    case "tool-result": {
      const body =
        part.status === "ok"
          ? json(part.output)
          : part.status === "error"
            ? `error: ${part.error?.message ?? ""}`
            : `${part.status}${part.reason ? `: ${part.reason}` : ""}`;
      return `[${String(part.name)} returned: ${truncate(body, Math.min(limit, 2_000))}]`;
    }
    case "output":
      return `[structured answer: ${truncate(json(part.value), Math.min(limit, 2_000))}]`;
    default:
      return "";
  }
}

function json(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[cut]`;
}

function positiveInt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

// --- fingerprints --------------------------------------------------------------

/**
 * `out[i]` is a fingerprint of `messages[0..i)`, for every `i` up to `end`.
 * A chain over each message's JSON, so one pass gives every prefix.
 */
export function prefixFingerprints(messages: readonly AgentMessage[], end: number): string[] {
  const out = ["0"];
  let chain = "";
  for (let i = 0; i < end; i++) {
    let body: string;
    try {
      body = JSON.stringify(messages[i]) ?? "";
    } catch {
      body = String(messages[i]?.id);
    }
    chain = hash(`${chain}|${hash(body)}`);
    out.push(chain);
  }
  return out;
}

/** cyrb53: a fast 53-bit string hash. Not cryptographic, and needn't be: it
 *  tells a changed history from an unchanged one, on the server's own data. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
