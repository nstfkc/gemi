import { createHash } from "node:crypto";

import {
  AgentProvider,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderStreamParams,
  type ProviderToolSpec,
} from "../AgentProvider";
import { s } from "../Schema";

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
};

/** How `replay` matches a request against the recorded one. */
export type RecordingMatch = "exact" | "tolerant";

export type RecordingProviderOptions = {
  /**
   * `"tolerant"` (the default): a request that differs from the recorded one
   * only in its instructions, its settings, the tools offered or the text of
   * its messages still replays, provided the conversation has the same shape
   * (the same roles, tool calls with the same inputs, tool results with the
   * same status) and every tool call the recorded answer makes fits today's
   * schema. The call is `stale` and says why. `"exact"` throws on any difference.
   */
  match?: RecordingMatch;
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
 * The shape of a conversation, which a tolerant match keeps: each message's
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
 * With `match: "tolerant"` (the default), a request that differs in its
 * instructions, settings, tools or message text, but not in the shape of the
 * conversation, still replays, and is counted in `stale` with the reason. A
 * recorded tool call that no longer fits its tool's schema, or calls a tool no
 * longer offered, throws: replaying it would test nothing. Anything else
 * throws a `RecordingMismatchError` that shows where the two differ.
 *
 * UPLOADS are answered `upload_<n>`, by order, so a file need not be the same
 * bytes on another machine for its call to replay. Recording, the file goes to
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
  private uploadCount = 0;
  /** Recording: the position the next call's prompt was pinned to. */
  private read?: number;
  private readonly shared: Shared;
  private readonly options: Required<Pick<RecordingProviderOptions, "match" | "ids" | "waitMs">> &
    RecordingProviderOptions;

  private constructor(
    private readonly live: AgentProvider | undefined,
    recording: Recording | undefined,
    options: RecordingProviderOptions,
    child?: { parent: RecordingProvider; key: string; calls: RecordedCall[] },
  ) {
    super();
    this.options = {
      ...options,
      match: options.match ?? "tolerant",
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
   * differed and were tolerated (`match: "tolerant"`). Empty for a replay
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
    const root = this.parent ?? this;
    const id = `upload_${++root.uploadCount}`;
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
    if (!root.matches(JSON.stringify(call.request), request)) {
      root.tolerate(where, call, request, params.tools ?? []);
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
    const { signal: _signal, messages, tools, ...rest } = params;
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
   * A request that is not the recorded one. Tolerated, and counted stale, when
   * matching is tolerant, the conversation has the same shape, and every tool
   * call of the recorded answer fits today's tools. Throws otherwise.
   */
  private tolerate(
    where: string,
    call: RecordedCall,
    request: RecordedRequest,
    tools: NonNullable<ProviderStreamParams["tools"]>,
  ): void {
    const recorded = call.request;
    const differs = (): never => {
      const theirs = JSON.stringify(recorded);
      const ours = JSON.stringify(request);
      let at = 0;
      while (at < theirs.length && theirs[at] === ours[at]) at++;
      throw new RecordingMismatchError(
        `${where}: the request differs from the recorded one${this.options.match === "tolerant" ? " in the conversation itself" : ""}. Recorded: …${theirs.slice(Math.max(0, at - 80), at + 120)}… Sent: …${ours.slice(Math.max(0, at - 80), at + 120)}…`,
      );
    };
    if (this.options.match === "exact") differs();
    // The conversation's shape, ids matched by place as for an exact match.
    if (!this.matches(JSON.stringify(shapeOf(recorded.messages)), shapeOf(request.messages))) {
      differs();
    }
    if ((recorded.after ?? 0) !== (request.after ?? 0)) differs();

    const reasons: string[] = [];
    const {
      messages: recordedMessages,
      tools: recordedTools,
      toolNames: recordedNames,
      after: _a,
      ...recordedRest
    } = recorded;
    const {
      messages: sentMessages,
      tools: sentTools,
      toolNames: sentNames,
      after: _b,
      ...sentRest
    } = request;
    if (!this.matches(JSON.stringify(recordedMessages), sentMessages)) {
      reasons.push("message text changed");
    }
    const fields = new Set([...Object.keys(recordedRest), ...Object.keys(sentRest)]);
    for (const field of [...fields].sort()) {
      if (!this.matches(JSON.stringify(recordedRest[field] ?? null), sentRest[field] ?? null)) {
        reasons.push(`${field} changed`);
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
        const checked = s
          .fromJSONSchema(spec.parameters as never, { unknownKeys: "error", formats })
          .safeParse(input);
        if (checked.ok === false) {
          throw new RecordingMismatchError(
            `${where}: the recorded call of ${event.name} does not fit its schema any more (${checked.errors.join("; ")}).`,
          );
        }
      }
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
          : "tool definitions changed",
      );
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
