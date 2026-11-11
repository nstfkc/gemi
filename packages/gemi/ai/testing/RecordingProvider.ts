import { createHash } from "node:crypto";

import {
  AgentProvider,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderStreamParams,
  type ProviderToolSpec,
} from "../AgentProvider";
import { JSONSchemaError, s } from "../Schema";
import { type FingerprintOptions, Fingerprints, type RecordingFingerprints } from "./Fingerprints";

/**
 * One model call, as a recording keeps it: what was sent (normalised, see
 * `RecordingProvider`) and what the model streamed back.
 */
export type RecordedCall = {
  request: RecordedRequest;
  events: ProviderEvent[];
  /** When it started among all the calls of the recording, its sub-runs' too (`ordered`). */
  at?: number;
  /** The app's position (`position`) the call's prompt was pinned to (`pin`). */
  read?: number;
  /** The app's position once the call's answer had streamed in full, before its tools ran. */
  ended?: number;
};

/**
 * A request as recorded. `messages` are the messages new since the call
 * before it (`after` says how many of that call's it resent), each without
 * the parts minted per run; `tools` is a hash of the tool list, and
 * `toolNames` the names it offered.
 */
export type RecordedRequest = {
  messages: { role: string; content: unknown }[];
  after?: number;
  tools?: string;
  toolNames?: string[];
  [field: string]: unknown;
};

/** What a `RecordingProvider` records, and replays from. Plain JSON: write it where you like. */
export type Recording = {
  version: 1;
  model: string;
  capabilities: ProviderCapabilities;
  /** When the recording started (ISO). A replay can run at that time: see `pinClock`. */
  recordedAt: string;
  calls: RecordedCall[];
  /** Sub-runs' calls (`nested(key)`), each in its own order. */
  nested?: Record<string, RecordedCall[]>;
  /** What it was made with, when recorded with `fingerprints`. See `Fingerprints`. */
  fingerprints?: RecordingFingerprints;
};

/** How `replay` matches a request against the recorded one. See `RecordingProviderOptions.match`. */
export type RecordingMatch = "exact" | "wording" | "shape";

export type RecordingProviderOptions = {
  /**
   * What a replayed request may differ in from the recorded one and still
   * replay, counted as `stale` with the reason:
   *
   * - `"wording"` (the default): the wording of the prompt files changed since
   *   the recording, and nothing else. The static text of those files is cut
   *   out of both requests (see `Fingerprints.cutters`), so the messages, the
   *   tool calls and results and every value filled into the prompts must
   *   still be the same. Needs a recording made with `fingerprints`, and
   *   `fingerprints` on the replay to find the files.
   * - `"shape"`: anything but the shape of the conversation (its roles, tool
   *   calls with their inputs, tool results with their status): instructions,
   *   settings and message text. For an app whose prompts are not files.
   * - `"exact"`: nothing.
   *
   * In `"wording"` and `"shape"`, the tools offered may differ too, as long as
   * every tool call the recorded answer makes is to a tool still offered and
   * fits its schema today.
   */
  match?: RecordingMatch;
  /**
   * Fingerprint what the recording is made with (the prompt files its
   * requests carried, its tools' definitions, `inputs`), and, replaying, tell
   * a reworded prompt by them. See `Fingerprints`.
   */
  fingerprints?: FingerprintOptions;
  /**
   * Ids minted per run (a record's id, say), which a replay mints anew. Each
   * recorded id matches the id at its place in the request, the same one
   * wherever it shows, and the recorded answer is given the replay's ids.
   * Default: UUIDs.
   */
  ids?: RegExp;
  /**
   * Replays the calls, the sub-runs' too, in the order they started when
   * recorded (`at`), for runs that go side by side and whose order shows.
   * Off, each run and sub-run replays in its own order, in any interleaving.
   */
  ordered?: boolean;
  /**
   * A position in the app's own state that moves as tools run (an edit log's
   * head, say). Recording, each call keeps where it was; replaying, a call's
   * answer waits until the app gets there again, so tool calls running side by
   * side write in the recorded order. See also `pin`.
   */
  position?: () => number | Promise<number>;
  /** How long a replay waits for `ordered` or `position` before it gives up. Default 60 s. */
  waitMs?: number;
};

/** A replayed request that is not the recorded one, beyond what `match` tolerates. */
export class RecordingMismatchError extends Error {
  constructor(message: string) {
    super(`${message} Record again.`);
    this.name = "RecordingMismatchError";
  }
}

const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** `value` with each of its strings passed through `change`. */
function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, mapStrings(inner, change)]),
    );
  }
  return value;
}

/**
 * A message's content without what a run mints and the model is not sent: a
 * tool call's sub-run transcript (`nested`, recorded on its own), and the full
 * output of a tool whose model reads a projection (`modelOutput`).
 */
function withoutTranscripts<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key, inner) {
      if (key === "nested") return undefined;
      if (key === "output" && this.type === "tool-result" && "modelOutput" in this) {
        return undefined;
      }
      return inner;
    }),
  );
}

function resolvers(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const flatTools = (tools: NonNullable<ProviderStreamParams["tools"]>): ProviderToolSpec[] =>
  tools.flatMap((tool) => ("tools" in tool ? tool.tools : [tool]));

/**
 * The shape of a conversation, which `match: "shape"` keeps: each message's
 * role, its tool calls with their inputs and its tool results with their
 * status, but not its text.
 */
function shapeOf(messages: { role: string; content: unknown }[]): unknown {
  return messages.map(({ role, content }) => ({
    role,
    parts: (Array.isArray(content) ? content : []).flatMap((part: any): unknown[] => {
      if (part?.type === "tool-call") return [{ call: part.name, input: part.input ?? part.args }];
      if (part?.type === "tool-result") return [{ result: part.name, status: part.status }];
      if (part?.type === "file") return [{ file: true }];
      return [];
    }),
  }));
}

type Shared = {
  ids: Map<string, string>;
  stale: Set<string>;
  staleCalls: number;
  started: number;
  pending?: number[];
  moved: { promise: Promise<void>; resolve: () => void };
};

/**
 * A provider that records a live provider's calls, and replays them later
 * without one: model-backed tests and evals that run in CI, offline and for
 * free, and stay the same from run to run.
 *
 *     // Recording: every call goes to `live`, and is kept.
 *     const recorder = RecordingProvider.record(live);
 *     await runTheCase(recorder);
 *     await Bun.write(file, JSON.stringify(recorder.recording()));
 *
 *     // Replaying: each call is answered with what was recorded for it.
 *     const replay = RecordingProvider.replay(await Bun.file(file).json());
 *     await runTheCase(replay);
 *     replay.stale; // why the recording should be made again, if it should
 *
 * WHAT IS MATCHED. The n-th call replays the n-th recorded call (per run and
 * per sub-run, see `nested`), and it has to be the same request:
 *
 * - Messages are compared without ids and times, which differ per run: only
 *   `role` and `content` are kept, without sub-run transcripts. A call resends
 *   the messages of the one before it, so only the new ones are recorded
 *   (`after`), and a recording grows with the run, not with its square.
 * - Ids minted per run (`ids`, UUIDs by default) are matched by place, and the
 *   recorded answer is given the replay's ids.
 * - The tool list is compared by its hash.
 *
 * A request that differs is stale rather than a mismatch only as far as
 * `match` allows. With `"wording"` (the default) that is the rewording of
 * prompt files changed since the recording: their static text is cut out of
 * both requests and the rest must be the same (see `Fingerprints`). The tools
 * offered may differ too, as long as each tool call the recorded answer makes
 * still exists and fits its schema today: replaying a call that doesn't
 * would test nothing. A stale call replays and is counted in `stale` with the
 * reason. Anything else throws a `RecordingMismatchError` that shows where
 * the two differ.
 *
 * UPLOADS are answered `upload_<n>`, by order, so a file need not be the same
 * bytes on another machine for its call to replay. A sub-run counts its own:
 * `upload_<key>_<n>`, so the ids stay the same however sub-runs interleave. Recording, the file goes to
 * the live provider, and the calls show the model the provider's id.
 *
 * TIME. `recordedAt` is when the recording started. `pinClock(recordedAt)`
 * runs a replay at that time, so dates relative to today come out as recorded.
 */
export class RecordingProvider extends AgentProvider {
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  /** When the recording started. */
  readonly recordedAt: Date;
  private readonly calls: RecordedCall[];
  /** Replaying: the recorded calls of the sub-runs, by key. */
  private readonly recordedNested: Record<string, RecordedCall[]>;
  private readonly children = new Map<string, RecordingProvider>();
  private parent?: RecordingProvider;
  private readonly key?: string;
  /** The messages of the previous call, which the next call's are recorded after. */
  private sent: unknown[] = [];
  /** Recording: the live provider's file id of each upload, by the id answered here. */
  private readonly uploads: Map<string, string>;
  /** Uploads answered so far, counted per run and per sub-run. */
  private uploadCount = 0;
  /** Recording: the position the next call's prompt was pinned to. */
  private read?: number;
  private readonly shared: Shared;
  private readonly options: Required<Pick<RecordingProviderOptions, "match" | "ids" | "waitMs">> &
    RecordingProviderOptions;
  /** What the calls sent, for the fingerprints: every string, and each tool's definition hashes. */
  private readonly texts = new Set<string>();
  private readonly toolHashes = new Map<string, Set<string>>();
  private readonly toolLists = new Set<string>();
  /** Replaying: the recording's fingerprints, and how a differing request is cut by them. */
  private recorded?: Fingerprints;
  private cuts?: ReturnType<Fingerprints["cutters"]>;

  private constructor(
    private readonly live: AgentProvider | undefined,
    recording: Recording | undefined,
    options: RecordingProviderOptions,
    child?: { parent: RecordingProvider; key: string; calls: RecordedCall[] },
  ) {
    super();
    this.options = {
      ...options,
      match: options.match ?? "wording",
      ids: new RegExp(options.ids ?? UUIDS, "g"),
      waitMs: options.waitMs ?? 60_000,
    };
    if (child) {
      const { parent } = child;
      this.parent = parent;
      this.key = child.key;
      this.model = parent.model;
      this.capabilities = parent.capabilities;
      this.recordedAt = parent.recordedAt;
      this.calls = child.calls;
      this.recordedNested = {};
      this.uploads = parent.uploads;
      this.shared = parent.shared;
      return;
    }
    this.shared = {
      ids: new Map(),
      stale: new Set(),
      staleCalls: 0,
      started: 0,
      moved: resolvers(),
    };
    this.uploads = new Map();
    if (live) {
      this.model = live.model;
      this.capabilities = live.capabilities;
      this.recordedAt = new Date();
      this.calls = [];
      this.recordedNested = {};
      return;
    }
    if (!recording || recording.version !== 1 || !Array.isArray(recording.calls)) {
      throw new Error("RecordingProvider.replay needs a recording made by RecordingProvider.");
    }
    this.model = recording.model;
    this.capabilities = recording.capabilities;
    this.recordedAt = new Date(recording.recordedAt);
    this.calls = structuredClone(recording.calls);
    this.recordedNested = structuredClone(recording.nested ?? {});
    if (recording.fingerprints) {
      this.recorded = new Fingerprints(recording.fingerprints, options.fingerprints);
    }
  }

  /** Records every call made through it to `live`, which answers it. */
  static record(live: AgentProvider, options: RecordingProviderOptions = {}): RecordingProvider {
    return new RecordingProvider(live, undefined, options);
  }

  /** Answers each call with the recorded one. See the class for how calls are matched. */
  static replay(recording: Recording, options: RecordingProviderOptions = {}): RecordingProvider {
    return new RecordingProvider(undefined, recording, options);
  }

  /** Whether it records (true) or replays. */
  get isRecording(): boolean {
    return this.live !== undefined;
  }

  /**
   * Why the replay should be recorded again: the parts of the requests that
   * differed and were tolerated (`match`). Empty for a replay
   * that matched exactly, and for a recording.
   */
  get stale(): ReadonlySet<string> {
    return this.shared.stale;
  }

  /** How many calls replayed stale, the sub-runs' included. */
  get staleCalls(): number {
    return this.shared.staleCalls;
  }

  /**
   * The provider of sub-run `key` (a sub-agent's, say), recorded and replayed
   * apart from this one's calls and the other sub-runs', so sub-runs running
   * side by side can replay in any interleaving. The same key answers the same
   * provider, so a sub-run continued later goes on after its calls. Replaying
   * a key the recording does not have throws.
   */
  nested(key: string): RecordingProvider {
    if (this.parent) return this.parent.nested(key);
    let child = this.children.get(key);
    if (!child) {
      const calls = this.recordedNested[key];
      if (!this.live && !calls) {
        throw new RecordingMismatchError(`The recording has no sub-run "${key}".`);
      }
      child = new RecordingProvider(this.live, undefined, this.options, {
        parent: this,
        key,
        calls: calls ?? [],
      });
      this.children.set(key, child);
    }
    return child;
  }

  /**
   * The recording so far: every call made through this provider and its
   * sub-runs. Write it as JSON. Only for a provider made with `record`.
   */
  recording(): Recording {
    if (this.parent) return this.parent.recording();
    if (!this.live)
      throw new Error("Only a recording provider (`record`) has a recording to save.");
    return {
      version: 1,
      model: this.model,
      capabilities: this.capabilities,
      recordedAt: this.recordedAt.toISOString(),
      calls: structuredClone(this.calls),
      ...(this.options.fingerprints ? { fingerprints: this.fingerprints().data } : {}),
      ...(this.children.size > 0
        ? {
            nested: Object.fromEntries(
              [...this.children].map(([key, child]) => [key, structuredClone(child.calls)]),
            ),
          }
        : {}),
    };
  }

  /**
   * The fingerprints of what the calls sent so far, the sub-runs' included:
   * of this recording, or of this replay (compare it with the recording's to
   * tell whether a new recording would differ). Uses the `fingerprints`
   * options for where prompts live.
   */
  fingerprints(): Fingerprints {
    const root = this.parent ?? this;
    return Fingerprints.of(root.texts, root.toolHashes, this.options.fingerprints);
  }

  /**
   * What changed since `recording` was made, without replaying it: the prompt
   * files and inputs its fingerprints name that differ today. Empty for a
   * recording without fingerprints. For listing the recordings to make again.
   */
  static changedSince(recording: Recording, options: FingerprintOptions = {}): string[] {
    return recording.fingerprints
      ? new Fingerprints(recording.fingerprints, options).changed()
      : [];
  }

  /**
   * Replaying: whether every recorded call was made, the sub-runs' too. A run
   * that took another path and stopped early made fewer.
   */
  replayedInFull(): boolean {
    const root = this.parent ?? this;
    return (
      root.calls.length === 0 &&
      Object.entries(root.recordedNested).every(
        ([key, calls]) => (root.children.get(key)?.calls ?? calls).length === 0,
      )
    );
  }

  /**
   * The position (`position`) the next call's prompt should show the app at,
   * given `now`, where it is. Recording, that is `now`, kept with the call.
   * Replaying, it is the recorded position, once the app has got there, so a
   * prompt rendered from the app's state is the one that was recorded,
   * however the other runs were timed.
   */
  async pin(now: number): Promise<number> {
    if (this.live) {
      this.read = now;
      return now;
    }
    const read = this.calls[0]?.read;
    if (read === undefined) return now;
    await (this.parent ?? this).reach(read, this.where());
    return read;
  }

  async upload(file: File): Promise<string> {
    const n = ++this.uploadCount;
    const id = this.key === undefined ? `upload_${n}` : `upload_${this.key}_${n}`;
    if (this.live) this.uploads.set(id, await this.live.upload(file));
    return id;
  }

  normalizeError(error: unknown) {
    return this.live ? this.live.normalizeError(error) : super.normalizeError(error);
  }

  async *stream(params: ProviderStreamParams): AsyncGenerator<ProviderEvent> {
    const request = this.requestOf(params);
    if (this.live) {
      yield* this.recordCall(params, request);
      return;
    }
    yield* this.replayCall(params, request);
  }

  // --- recording ---------------------------------------------------------------

  private async *recordCall(
    params: ProviderStreamParams,
    request: RecordedRequest,
  ): AsyncGenerator<ProviderEvent> {
    const root = this.parent ?? this;
    const at = root.shared.started++;
    const read = this.read;
    this.read = undefined;
    const events: ProviderEvent[] = [];
    // The live call shows the model the files it uploaded, by the provider's ids.
    const messages = params.messages.map((message) => ({
      ...message,
      content: message.content.map((part) =>
        part.type === "file" && part.fileId && this.uploads.has(part.fileId)
          ? { ...part, fileId: this.uploads.get(part.fileId) }
          : part,
      ),
    }));
    for await (const event of this.live!.stream({ ...params, messages })) {
      const last = events.at(-1);
      if (event.type === "tool-call-discard") {
        // The provider asked again: the discarded calls' deltas are void.
        const discarded = new Set(event.toolCallIds);
        const kept = events.filter(
          (e) => e.type !== "tool-call-delta" || !discarded.has(e.toolCallId),
        );
        events.splice(0, events.length, ...kept);
      } else if (event.type === "retry") {
        // How the live call went, not what it answered.
      } else if (
        last &&
        (event.type === "text-delta" || event.type === "output-delta") &&
        last.type === event.type
      ) {
        // Consecutive deltas are kept as one, which replays the same text.
        last.delta += event.delta;
      } else if (
        last?.type === "tool-call-delta" &&
        event.type === "tool-call-delta" &&
        last.toolCallId === event.toolCallId
      ) {
        last.argsDelta += event.argsDelta;
      } else {
        events.push({ ...event });
      }
      yield event;
    }
    const ended = this.options.position ? await this.options.position() : undefined;
    this.calls.push({
      request,
      events,
      at,
      ...(read !== undefined ? { read } : {}),
      ...(ended !== undefined ? { ended } : {}),
    });
  }

  // --- replaying ---------------------------------------------------------------

  private async *replayCall(
    params: ProviderStreamParams,
    request: RecordedRequest,
  ): AsyncGenerator<ProviderEvent> {
    const root = this.parent ?? this;
    const where = this.where();
    const next = this.calls[0];
    if (this.options.ordered && next?.at !== undefined) await root.turn(next.at, where);
    const call = this.calls.shift();
    if (!call) {
      throw new RecordingMismatchError(
        `${where}: call ${this.sentCalls} was not recorded (the recording has no more calls).`,
      );
    }
    // A recording made with 0.204.0 kept the request's `promptCacheKey`: it is
    // not compared (see `requestOf`).
    const { promptCacheKey: _cacheKey, ...recorded } = call.request;
    if (!root.matches(JSON.stringify(recorded), request)) {
      root.tolerate(
        where,
        { ...call, request: recorded as RecordedRequest },
        request,
        params.tools ?? [],
      );
    }
    if (call.ended !== undefined) await root.reach(call.ended, where);
    const ids = root.shared.ids;
    for (const event of call.events) {
      yield JSON.parse(
        JSON.stringify(event).replace(this.options.ids, (id) => ids.get(id) ?? id),
      ) as ProviderEvent;
    }
  }

  private where(): string {
    return this.key === undefined ? "the recording" : `sub-run "${this.key}"`;
  }

  /** How many calls were made through this provider (not its sub-runs). */
  private sentCalls = 0;

  /**
   * The request as it is recorded and matched: see the class. Also moves
   * `sent` on, so the next call is recorded after this one.
   */
  private requestOf(params: ProviderStreamParams): RecordedRequest {
    this.sentCalls++;
    // `promptCacheKey` is derived from the prompt and the tools (#1228): it
    // changes whenever they are reworded, and recordings made before it have
    // none. It says nothing the request doesn't already say, so it is neither
    // matched nor fingerprinted (#1231).
    const { signal: _signal, promptCacheKey: _cacheKey, messages, tools, ...rest } = params;
    const sent = messages.map(({ role, content }) => ({
      role,
      content: withoutTranscripts(content),
    }));
    const after =
      this.sent.length > 0 &&
      this.sent.length <= sent.length &&
      JSON.stringify(sent.slice(0, this.sent.length)) === JSON.stringify(this.sent)
        ? this.sent.length
        : 0;
    this.sent = sent;
    const listed = tools && tools.length > 0 ? JSON.stringify(tools) : undefined;
    const root = this.parent ?? this;
    const keep = (text: string) => {
      root.texts.add(text);
      return text;
    };
    mapStrings([rest, sent.slice(after)], keep);
    if (listed && !root.toolLists.has(listed)) {
      root.toolLists.add(listed);
      for (const tool of flatTools(tools!)) {
        mapStrings(tool, keep);
        const hashes = root.toolHashes.get(tool.name) ?? new Set<string>();
        hashes.add(Fingerprints.tool(tool));
        root.toolHashes.set(tool.name, hashes);
      }
    }
    return {
      ...(withoutTranscripts(rest) as Record<string, unknown>),
      ...(listed
        ? {
            tools: `sha256:${sha256(listed)}`,
            toolNames: flatTools(tools!)
              .map((tool) => tool.name)
              .sort(),
          }
        : {}),
      ...(after > 0 ? { after } : {}),
      messages: sent.slice(after),
    };
  }

  /**
   * Whether `request` is the recorded one (`recorded`, as JSON), with each
   * recorded id matched to the id at its place in the request, the same one
   * every time it shows (`ids`, shared by the runs and sub-runs).
   */
  private matches(recorded: string, request: unknown): boolean {
    const pattern = this.options.ids;
    const sent = JSON.stringify(request);
    const theirs = recorded.match(pattern) ?? [];
    const ours = sent.match(pattern) ?? [];
    if (theirs.length !== ours.length) return false;
    const ids = new Map(this.shared.ids);
    for (const [index, id] of theirs.entries()) {
      const mapped = ids.get(id) ?? ours[index]!;
      if (mapped !== ours[index]) return false;
      ids.set(id, mapped);
    }
    if (recorded.replace(pattern, (id) => ids.get(id)!) !== sent) return false;
    for (const [id, mapped] of ids) this.shared.ids.set(id, mapped);
    return true;
  }

  /**
   * A request that is not the recorded one. It replays, stale, when what
   * differs is what `match` allows (see `RecordingProviderOptions.match`), and
   * every tool call of the recorded answer fits today's tools if those differ.
   * Throws otherwise, showing where the two first differ.
   */
  private tolerate(
    where: string,
    call: RecordedCall,
    request: RecordedRequest,
    tools: NonNullable<ProviderStreamParams["tools"]>,
  ): void {
    const pattern = this.options.ids;
    const match = this.options.match;
    const recorded = call.request;
    const differs = (theirs: unknown, ours: unknown, why: string): never => {
      // Where they first differ, ids aside (they are matched by place).
      const a = JSON.stringify(theirs).replace(pattern, "<id>");
      const b = JSON.stringify(ours).replace(pattern, "<id>");
      let at = 0;
      while (at < a.length && a[at] === b[at]) at++;
      throw new RecordingMismatchError(
        `${where}: the request differs from the recorded one${why}. Recorded: …${a.slice(Math.max(0, at - 80), at + 120)}… Sent: …${b.slice(Math.max(0, at - 80), at + 120)}…`,
      );
    };
    if (match === "exact") differs(recorded, request, "");

    const { tools: recordedTools, toolNames: recordedNames, ...recordedRest } = recorded;
    const { tools: sentTools, toolNames: sentNames, ...sentRest } = request;
    const reasons: string[] = [];

    if (!this.matches(JSON.stringify(recordedRest), sentRest)) {
      if (match === "wording") {
        if (!this.recorded) {
          differs(
            recordedRest,
            sentRest,
            ", and the recording has no fingerprints to tell a reworded prompt by",
          );
        }
        try {
          this.cuts ??= this.recorded!.cutters();
        } catch (error) {
          throw new RecordingMismatchError(`${where}: ${(error as Error).message}.`);
        }
        const theirs = mapStrings(recordedRest, this.cuts.recorded);
        const ours = mapStrings(sentRest, this.cuts.sent);
        if (this.cuts.changed.length === 0 || !this.matches(JSON.stringify(theirs), ours)) {
          differs(
            theirs,
            ours,
            this.cuts.changed.length > 0 ? ", beyond the wording of the prompts changed since" : "",
          );
        }
        reasons.push(...this.cuts.changed.map((path) => `${path} changed`));
      } else {
        // The conversation's shape, ids matched by place as for an exact match.
        const sameShape =
          (recorded.after ?? 0) === (request.after ?? 0) &&
          this.matches(JSON.stringify(shapeOf(recorded.messages)), shapeOf(request.messages));
        if (!sameShape) differs(recordedRest, sentRest, " in the conversation itself");
        const { messages: recordedMessages, ...recordedSettings } = recordedRest;
        const { messages: sentMessages, ...sentSettings } = sentRest;
        if (!this.matches(JSON.stringify(recordedMessages), sentMessages)) {
          reasons.push("message text changed");
        }
        const fields = new Set([...Object.keys(recordedSettings), ...Object.keys(sentSettings)]);
        for (const field of [...fields].sort()) {
          const theirs = JSON.stringify(recordedSettings[field] ?? null);
          if (!this.matches(theirs, sentSettings[field] ?? null)) reasons.push(`${field} changed`);
        }
      }
    }

    if (recordedTools !== sentTools) {
      const specs = flatTools(tools);
      for (const event of call.events) {
        if (event.type !== "tool-call") continue;
        const spec = specs.find((tool) => tool.name === event.name);
        if (!spec) {
          throw new RecordingMismatchError(
            `${where}: the recorded answer calls ${event.name}, which is not offered any more.`,
          );
        }
        // Formats are hints here: the tool checks them itself when the call runs.
        const formats = Object.fromEntries(
          [...JSON.stringify(spec.parameters).matchAll(/"format":"([^"]+)"/g)].map(([, f]) => [
            f!,
            true as const,
          ]),
        );
        let input: unknown;
        try {
          input = JSON.parse(event.args || "{}");
        } catch {
          input = undefined;
        }
        // A schema `fromJSONSchema` can't model (a free-form part, such as an
        // object value with no type) isn't checked here (#1234): the tool still
        // validates its input when the call runs, as for formats.
        let schema: ReturnType<typeof s.fromJSONSchema> | undefined;
        try {
          schema = s.fromJSONSchema(spec.parameters as never, { unknownKeys: "error", formats });
        } catch (error) {
          if (!(error instanceof JSONSchemaError)) throw error;
        }
        const checked = schema?.safeParse(input);
        if (checked && checked.ok === false) {
          throw new RecordingMismatchError(
            `${where}: the recorded call of ${event.name} does not fit its schema any more (${checked.errors.join("; ")}).`,
          );
        }
      }
      if (this.recorded) {
        const changed = specs
          .filter(
            (tool) => !this.recorded!.data.tools[tool.name]?.includes(Fingerprints.tool(tool)),
          )
          .map((tool) => tool.name)
          .sort();
        reasons.push(
          changed.length > 0 ? `tools changed: ${changed.join(", ")}` : "the tools offered changed",
        );
      } else {
        const before = new Set(recordedNames ?? []);
        const now = new Set(sentNames ?? []);
        const added = [...now].filter((name) => !before.has(name));
        const removed = [...before].filter((name) => !now.has(name));
        reasons.push(
          added.length > 0 || removed.length > 0
            ? `tools offered changed (${[
                ...added.map((name) => `+${name}`),
                ...removed.map((name) => `-${name}`),
              ].join(", ")})`
            : "the tools offered changed",
        );
      }
    }
    this.shared.staleCalls++;
    for (const reason of reasons) this.shared.stale.add(reason);
  }

  /** Waits until every recorded call that started before `at` has started (`ordered`). */
  private async turn(at: number, where: string): Promise<void> {
    const shared = this.shared;
    shared.pending ??= [...this.calls, ...Object.values(this.recordedNested).flat()]
      .map((call) => call.at)
      .filter((started): started is number => started !== undefined)
      .sort((a, b) => a - b);
    while (shared.pending[0] !== undefined && shared.pending[0] < at) {
      const moved = shared.moved.promise;
      const waited = await Promise.race([
        moved.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.options.waitMs)),
      ]);
      if (!waited) {
        throw new RecordingMismatchError(
          `${where}: call ${at} waits for call ${shared.pending[0]}, which the replay does not make.`,
        );
      }
    }
    shared.pending = shared.pending.filter((started) => started !== at);
    shared.moved.resolve();
    shared.moved = resolvers();
  }

  /** Waits until the app's `position` is at `target` or past it. */
  private async reach(target: number, where: string): Promise<void> {
    const position = this.options.position;
    if (!position) return;
    let last = await position();
    let still = 0;
    while (last < target) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const now = await position();
      still = now === last ? still + 25 : 0;
      last = now;
      if (still >= this.options.waitMs) {
        throw new RecordingMismatchError(
          `${where}: a call waits for the app to reach ${target}; it stays at ${last}.`,
        );
      }
    }
  }
}
