import { ToolError } from "../redact";
import { s } from "../Schema";
import type { Schema } from "../Schema";
import {
  AgentMemories,
  AgentMemoryRefusedError,
  deleteMemories,
  writeMemory,
} from "./AgentMemories";
import type {
  AgentMemoryKind,
  AgentMemoryRecord,
  AgentMemorySource,
  AgentMemoryWriteAction,
} from "./AgentMemoryStore";
import { renderMemoryBlock } from "./contextBlock";
import {
  MAX_MEMORY_TAGS,
  MEMORY_KEY_PATTERN,
  MEMORY_KIND_PATTERN,
  MEMORY_TAG_PATTERN,
  normalizedContent,
  oneLine,
  secretIn,
} from "./safety";
import { DEFAULT_RECALL_LIMIT } from "./search";

// --- the agent's declaration ---------------------------------------------

/** One scope an agent declares: a label the model sees, and what it is for. */
export type AgentMemoryScopeOptions = {
  /** What the model is told the scope is for. One sentence. */
  description: string;
  /**
   * Whether the model may write here with `remember` and `forget`. Default
   * `true`. `false` makes the scope read-only for the model: it is still in
   * the `<memory>` block and `recall`, and a tool's `ctx.memory` can still
   * write to it.
   */
  write?: boolean;
  /** The kinds the model may write here. Default `fact`, `preference` and `note`. */
  kinds?: readonly string[];
};

/** A built-in tool: on, off, or on behind the user's approval. */
export type AgentMemoryToolOption = boolean | { requiresApproval?: boolean };

/**
 * `Agent.create({ memory })` (#936): the scopes an agent remembers in, the
 * `<memory>` block, the built-in tools and their limits.
 *
 *     memory: {
 *       scopes: {
 *         project: { description: "This business and its brand: facts, tone, preferences." },
 *         user: { description: "The person, across their projects.", write: false },
 *       },
 *       maxTokens: 1500,
 *     }
 *
 * The labels are what the model sees. Which scope keys they stand for is
 * decided per run, on the server: `AgentController.memoryScopes()`, or
 * `memory.scopes` on `Agent.stream`. A label the run does not resolve is off
 * for that run: not in the block, not in the tools.
 */
export type AgentMemoryOptions = {
  /**
   * Labels and what each is for. Lowercase letters, digits and `_`. A
   * `thread` label is resolved to the run's thread (`thread:<threadId>`)
   * when the run has one and the caller does not resolve it otherwise.
   */
  scopes: Readonly<Record<string, AgentMemoryScopeOptions>>;
  /**
   * The `<memory>` block's budget, in tokens (about four characters each).
   * Default 1,500. `0` leaves the block out. A run may set its own
   * (`Agent.stream({ memory: { maxTokens } })`, or the controller's
   * `memoryMaxTokens`).
   */
  maxTokens?: number;
  /**
   * Which kinds the block lists: all of them by default. `false` leaves the
   * block out; the tools still work, and the model finds memories with
   * `recall`.
   */
  context?: { kinds?: readonly string[] } | false;
  /**
   * The built-in `remember`, `forget` and `recall` tools, in the reserved
   * `memory` namespace. All on by default and none needs approval;
   * `{ remember: { requiresApproval: true } }` asks the user first.
   * `false` turns all three off, leaving the block and `ctx.memory`.
   */
  tools?:
    | boolean
    | {
        remember?: AgentMemoryToolOption;
        forget?: AgentMemoryToolOption;
        recall?: boolean;
      };
  /** The limits on what one run may write. See `DEFAULT_MEMORY_LIMITS`. */
  limits?: {
    /** The longest content, in characters. Default 500. */
    maxChars?: number;
    /** The most memories a scope may hold before an agent may add another. Default 200. */
    maxPerScope?: number;
    /** The most writes (`remember` and `forget`) one run may make, its sub-runs included. Default 10. */
    maxWritesPerRun?: number;
  };
};

/**
 * Labels resolved to scope keys for one run, e.g.
 * `{ project: "project:clx…", user: null }`. `null`, `undefined` or a
 * missing label: that label is off for the run.
 */
export type AgentMemoryScopes = Record<string, string | null | undefined>;

/** `Agent.stream({ memory })`. */
export type AgentRunMemoryParams = {
  /** The run's scope keys, by label. Decided on the server; never from the client. */
  scopes: AgentMemoryScopes;
  /** The `<memory>` block's budget for this run, overriding the agent's. */
  maxTokens?: number;
};

export const DEFAULT_MEMORY_LIMITS = {
  maxChars: 500,
  maxPerScope: 200,
  maxWritesPerRun: 10,
} as const;

/** The kinds the model may write when a scope does not say. */
export const DEFAULT_MEMORY_TOOL_KINDS = ["fact", "preference", "note"] as const;

/** Reserved: the built-in memory tools are lowered into a namespace of exactly this name. */
export const MEMORY_NAMESPACE = "memory";

export const MEMORY_NAMESPACE_DESCRIPTION =
  "Long-term memory: short notes kept across conversations with this user. Save what the user tells you to remember or clearly states as lasting (facts, preferences, corrections), forget what is wrong or outdated, and search the notes that are not shown.";

/** The built-in tools' names. Global within an agent, like every tool name. */
export const MEMORY_TOOL_NAMES = ["remember", "forget", "recall"] as const;

const LABEL_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Throws at `Agent.create` for a declaration that cannot work. */
export function assertMemoryOptions(agent: string, options: AgentMemoryOptions): void {
  const owner = `The agent "${agent}"`;
  if (typeof options !== "object" || options === null || typeof options.scopes !== "object") {
    throw new Error(`${owner} sets \`memory\` without \`scopes\`. Declare at least one scope.`);
  }
  const labels = Object.keys(options.scopes);
  if (labels.length === 0) {
    throw new Error(`${owner} declares \`memory.scopes\` with no scope. Declare at least one.`);
  }
  for (const label of labels) {
    if (!LABEL_PATTERN.test(label)) {
      throw new Error(
        `${owner} declares the memory scope "${label}". A label is lowercase letters, digits and \`_\`, starting with a letter, at most 32.`,
      );
    }
    const scope = options.scopes[label]!;
    if (typeof scope?.description !== "string" || scope.description.trim() === "") {
      throw new Error(
        `${owner} declares the memory scope "${label}" without a \`description\`. The model reads it to decide where a memory goes.`,
      );
    }
    for (const kind of scope.kinds ?? []) {
      if (!MEMORY_KIND_PATTERN.test(kind)) {
        throw new Error(
          `${owner} lists the memory kind "${kind}" for "${label}". A kind is lowercase letters, digits, \`_\` and \`-\`, at most 32.`,
        );
      }
    }
    if (scope.kinds !== undefined && scope.kinds.length === 0) {
      throw new Error(
        `${owner} lists no memory kinds for "${label}". Leave \`kinds\` out for the default, or set \`write: false\`.`,
      );
    }
  }
  if (options.maxTokens !== undefined) assertWhole(options.maxTokens, owner, "memory.maxTokens", 0);
  for (const field of ["maxChars", "maxPerScope", "maxWritesPerRun"] as const) {
    const value = options.limits?.[field];
    if (value !== undefined) assertWhole(value, owner, `memory.limits.${field}`, 1);
  }
}

function assertWhole(value: unknown, owner: string, field: string, min: number): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= min) return;
  throw new Error(
    `${owner} sets \`${field}\` to ${String(value)}, but it has to be a whole number of at least ${min}.`,
  );
}

/** Which built-in tools a declaration turns on. */
export function memoryToolsEnabled(options: AgentMemoryOptions): {
  remember: { requiresApproval: boolean } | null;
  forget: { requiresApproval: boolean } | null;
  recall: boolean;
} {
  const tools = options.tools ?? true;
  if (tools === false) return { remember: null, forget: null, recall: false };
  if (tools === true) {
    return {
      remember: { requiresApproval: false },
      forget: { requiresApproval: false },
      recall: true,
    };
  }
  const writer = (option: AgentMemoryToolOption | undefined) =>
    option === false
      ? null
      : { requiresApproval: typeof option === "object" && option.requiresApproval === true };
  return {
    remember: writer(tools.remember),
    forget: writer(tools.forget),
    recall: tools.recall !== false,
  };
}

// --- the tools' inputs and outputs ---------------------------------------

export type RememberInput = {
  scope: string;
  kind: string;
  content: string;
  key?: string;
  replaces?: string;
  tags?: string[];
};

/**
 * What `remember` answers, and what a UI reads off the tool part to show
 * "Saved to memory · Undo": `part.name === "remember"`, then `part.output`.
 * `scope` is the label, never the key. Undo calls the app's own route, which
 * calls `AgentMemories.delete(id)`.
 */
export type RememberResult = {
  id: string;
  /** The label, e.g. `project`. */
  scope: string;
  kind: string;
  content: string;
  key: string | null;
  action: AgentMemoryWriteAction;
};

export type ForgetInput = { id: string; reason?: string };

/** What `forget` answers. */
export type ForgetResult = { id: string; scope: string; content: string; action: "forgotten" };

export type RecallInput = {
  query: string;
  scope?: string;
  kinds?: string[];
  limit?: number;
};

/** What `recall` answers. */
export type RecallResult = {
  memories: {
    id: string;
    scope: string;
    kind: string;
    content: string;
    key: string | null;
    /** ISO 8601, UTC. */
    updatedAt: string;
  }[];
};

/**
 * The built-in tools' shapes, added to an agent's tool shapes when it
 * declares `memory`, so the client's tool parts are typed:
 *
 *     if (part.type === "tool-result" && part.name === "remember") part.output.content;
 */
export type MemoryToolShapes = {
  remember: { input: RememberInput; output: RememberResult; progress: never };
  forget: { input: ForgetInput; output: ForgetResult; progress: never };
  recall: { input: RecallInput; output: RecallResult; progress: never };
};

/**
 * The tools' input schemas, built for the labels a run has. The scope is an
 * enum of labels, so the model cannot name a key, and a label the run did
 * not resolve is not a value it can send.
 */
export function memoryToolSchema(
  name: (typeof MEMORY_TOOL_NAMES)[number],
  params: { scopes: readonly string[]; descriptions: string; kinds: readonly string[] },
): Schema<any> {
  const scopes = params.scopes as [string, ...string[]];
  switch (name) {
    case "remember":
      return s.object({
        scope: s.enum(scopes).describe(`Where the note belongs. ${params.descriptions}`),
        kind: s
          .enum(params.kinds as [string, ...string[]])
          .describe(
            "fact: something true about the user or their work. preference: how they want things done. note: a working note.",
          ),
        content: s
          .string()
          .describe(
            "One self-contained sentence, written so it makes sense on its own in a later conversation. No secrets.",
          ),
        key: s
          .string()
          .optional()
          .describe(
            'A stable slot for a fact that changes, e.g. "business.hours" or "brand.voice": saving with the same key replaces what is there.',
          ),
        replaces: s
          .string()
          .optional()
          .describe("The id of a note this one corrects or replaces."),
        tags: s.array(s.string()).optional().describe("Short labels, if the instructions ask for them."),
      });
    case "forget":
      return s.object({
        id: s.string().describe("The note's id, e.g. mem_…"),
        reason: s.string().optional().describe("Why, in a few words."),
      });
    case "recall":
      return s.object({
        query: s.string().describe("Words to look for."),
        scope: s.enum(scopes).optional().describe("Only this scope."),
        kinds: s.array(s.string()).optional().describe("Only these kinds."),
        limit: s.number().optional().describe(`At most this many. Default ${DEFAULT_RECALL_LIMIT}.`),
      });
  }
}

export const REMEMBER_DESCRIPTION =
  "Save a short note to long-term memory, so later conversations know it. Use it when the user asks you to remember something, corrects you, or states a lasting fact or preference; not for one-off requests about the current task. Only save what the user said or clearly confirmed, one fact per note, never passwords, keys or card numbers. Update an existing note (same key, or `replaces`) rather than saving a near-duplicate. The user sees each saved note and can undo it.";

export const FORGET_DESCRIPTION =
  "Delete a note from long-term memory by its id: when the user asks you to forget it, or it turned out wrong or outdated.";

export const RECALL_DESCRIPTION =
  "Search long-term memory for notes that are not shown in the <memory> block. Keyword search: use the words the note would contain.";

// --- the run's handle ----------------------------------------------------

/**
 * `ctx.memory`: the run's memory, for a tool (#936).
 *
 * Shaped like `ctx.attachments`: always present, and none of its methods
 * takes a scope key. A tool names a scope by its label (`"project"`), the
 * run maps it to the key the server resolved, and a label the run does not
 * have is a `ToolError` ("No project memory in this conversation"). An id
 * from another scope reads as not found, with the same words as an unknown
 * id. So nothing a model puts in a tool's arguments can reach another
 * tenant's memories.
 *
 * Reads are for passing memories on where there is no `<memory>` block: a
 * `ctx.generate` sub-call, a prompt a tool builds.
 *
 *     const prefs = await ctx.memory.list("project", { kinds: ["preference"], tags: ["pictures"] });
 */
export interface ToolMemory {
  /** The labels this run has, in the order the agent declares them. */
  readonly scopes: readonly string[];
  /** Whether the run has this label. */
  has(scope: string): boolean;
  /** A scope's memories, oldest first. Without a scope, every scope's. */
  list(
    scope?: string,
    options?: { kinds?: readonly string[]; tags?: readonly string[]; limit?: number },
  ): Promise<AgentMemoryRecord[]>;
  /** Keyword search, best first, across the run's scopes or one of them. */
  recall(
    query: string,
    options?: {
      scope?: string;
      kinds?: readonly string[];
      tags?: readonly string[];
      limit?: number;
    },
  ): Promise<AgentMemoryRecord[]>;
  /** A memory of the run's scopes, or `null`. */
  get(id: string): Promise<AgentMemoryRecord | null>;
  /**
   * Saves a memory, as the app (`source.by: "app"`), held to the same checks
   * and limits as the model's `remember`: length, secrets, the scope's size
   * and the run's writes. A scope the agent declares read-only for the model
   * (`write: false`) may still be written here.
   */
  remember(params: {
    scope: string;
    kind: AgentMemoryKind;
    content: string;
    key?: string;
    tags?: string[];
    pinned?: boolean;
    replaces?: string;
  }): Promise<{ record: AgentMemoryRecord; action: AgentMemoryWriteAction }>;
  /** Hard-deletes a memory of the run's scopes. `false` when there was none. */
  forget(id: string): Promise<boolean>;
}

/** What only the built-in tools may call, behind a symbol `ctx.memory` does not show. */
export const MEMORY_TOOL_ACCESS = Symbol("gemi.memory.tools");

type ToolAccess = {
  remember(input: RememberInput): Promise<RememberResult>;
  forget(input: ForgetInput): Promise<ForgetResult>;
  recall(input: RecallInput): Promise<RecallResult>;
};

/** The internal half of `ctx.memory`, for the built-in tools. */
export function memoryToolAccess(memory: ToolMemory): ToolAccess {
  const access = (memory as ToolMemory & { [MEMORY_TOOL_ACCESS]?: ToolAccess })[MEMORY_TOOL_ACCESS];
  if (!access) throw new ToolError("There is no memory in this conversation.", { retryable: false });
  return access;
}

/** Writes made by a run and its sub-runs, counted against `maxWritesPerRun`. */
export type MemoryWriteCounter = { count: number };

/**
 * One run's memory: its labels resolved to keys, its write counter, and the
 * checks every write the run makes goes through.
 */
export class RunMemory {
  /** Resolved labels, in declared order. */
  readonly labels: string[];
  readonly writes: MemoryWriteCounter;
  private readonly keys: Map<string, string>;
  private readonly options: AgentMemoryOptions | undefined;
  private readonly limits: { maxChars: number; maxPerScope: number; maxWritesPerRun: number };
  private readonly origin: { agent: string; runId: string; threadId?: string };

  constructor(params: {
    options: AgentMemoryOptions | undefined;
    scopes: AgentMemoryScopes | undefined;
    agent: string;
    runId: string;
    threadId?: string;
    writes?: MemoryWriteCounter;
  }) {
    this.options = params.options;
    this.origin = { agent: params.agent, runId: params.runId, threadId: params.threadId };
    this.writes = params.writes ?? { count: 0 };
    this.limits = { ...DEFAULT_MEMORY_LIMITS, ...params.options?.limits };
    this.keys = new Map();
    for (const label of Object.keys(params.options?.scopes ?? {})) {
      const given = params.scopes?.[label];
      if (typeof given === "string" && given !== "") {
        this.keys.set(label, given);
      } else if (
        label === "thread" &&
        given === undefined &&
        params.threadId !== undefined &&
        params.threadId !== ""
      ) {
        this.keys.set(label, `thread:${params.threadId}`);
      }
    }
    this.labels = [...this.keys.keys()];
  }

  /** Labels the model may write to: resolved and not `write: false`. */
  writableLabels(): string[] {
    return this.labels.filter((label) => this.options?.scopes[label]?.write !== false);
  }

  /** The kinds the model may write into any of its writable labels. */
  toolKinds(): string[] {
    const kinds = new Set<string>();
    for (const label of this.writableLabels()) {
      for (const kind of this.kindsFor(label)) kinds.add(kind);
    }
    return [...kinds];
  }

  /** "project: …; user: …", for the tools' scope field. */
  describeScopes(labels: readonly string[]): string {
    return labels
      .map((label) => `${label}: ${oneLine(this.options!.scopes[label]!.description)}`)
      .join(" ");
  }

  /** The `<memory>` block for the run, or `null` when it has none. */
  async block(params: { maxTokens: number; recall: boolean; tools: boolean }): Promise<string | null> {
    const context = this.options?.context;
    if (context === false || this.labels.length === 0 || params.maxTokens <= 0) return null;
    const keys = this.labels.map((label) => this.keys.get(label)!);
    const memories = await AgentMemories.store.list(
      keys,
      context?.kinds ? { kinds: context.kinds } : {},
    );
    return renderMemoryBlock(
      this.labels.map((label) => ({
        label,
        memories: memories.filter((memory) => memory.scope === this.keys.get(label)),
      })),
      params,
    );
  }

  /** `ctx.memory` for one tool call. */
  handle(source: { messageId?: string } = {}): ToolMemory {
    const keyOf = (label: string) => this.keyOf(label);
    const handle: ToolMemory & { [MEMORY_TOOL_ACCESS]: ToolAccess } = {
      scopes: Object.freeze([...this.labels]),
      has: (scope) => this.keys.has(scope),
      list: async (scope, options = {}) => {
        const keys = scope === undefined ? this.allKeys() : [keyOf(scope)];
        if (keys.length === 0) return [];
        return AgentMemories.store.list(keys, options);
      },
      recall: async (query, options = {}) => {
        const keys = options.scope === undefined ? this.allKeys() : [keyOf(options.scope)];
        if (keys.length === 0) return [];
        return AgentMemories.store.search(keys, query, options);
      },
      get: (id) => this.find(id),
      remember: async (params) => {
        const result = await this.write(
          { ...params, tags: params.tags ?? [] },
          { by: "app", ...source },
          { modelWrite: false },
        );
        return { record: result.record, action: result.action };
      },
      forget: async (id) => {
        const record = await this.find(id);
        if (!record) return false;
        this.spend();
        return (await deleteMemories([record.id], "app")) > 0;
      },
      [MEMORY_TOOL_ACCESS]: {
        remember: async (input) => {
          const result = await this.write(
            {
              scope: input.scope,
              kind: input.kind,
              content: input.content,
              key: input.key,
              replaces: input.replaces,
              tags: input.tags ?? [],
            },
            { by: "agent", ...source },
            { modelWrite: true },
          );
          return {
            id: result.record.id,
            scope: input.scope,
            kind: result.record.kind,
            content: result.record.content,
            key: result.record.key,
            action: result.action,
          };
        },
        forget: async (input) => {
          const record = await this.find(input.id, this.writableLabels());
          if (!record) throw notFound(input.id);
          this.spend();
          await deleteMemories([record.id], "agent", input.reason);
          return {
            id: record.id,
            scope: this.labelOf(record.scope)!,
            content: record.content,
            action: "forgotten",
          };
        },
        recall: async (input) => {
          const keys = input.scope === undefined ? this.allKeys() : [keyOf(input.scope)];
          const limit =
            input.limit === undefined
              ? DEFAULT_RECALL_LIMIT
              : Math.min(50, Math.max(1, Math.floor(input.limit)));
          const found =
            keys.length === 0
              ? []
              : await AgentMemories.store.search(keys, input.query, {
                  ...(input.kinds && input.kinds.length > 0 ? { kinds: input.kinds } : {}),
                  limit,
                });
          return {
            memories: found.map((memory) => ({
              id: memory.id,
              scope: this.labelOf(memory.scope)!,
              kind: memory.kind,
              content: memory.content,
              key: memory.key,
              updatedAt: new Date(memory.updatedAt).toISOString(),
            })),
          };
        },
      },
    };
    return handle;
  }

  private allKeys(): string[] {
    return this.labels.map((label) => this.keys.get(label)!);
  }

  private keyOf(label: string): string {
    const key = this.keys.get(label);
    if (key === undefined) {
      throw new ToolError(`No ${label} memory in this conversation.`, { retryable: false });
    }
    return key;
  }

  private labelOf(key: string): string | undefined {
    for (const [label, value] of this.keys) if (value === key) return label;
    return undefined;
  }

  private kindsFor(label: string): readonly string[] {
    return this.options?.scopes[label]?.kinds ?? DEFAULT_MEMORY_TOOL_KINDS;
  }

  /** A memory in one of `labels`' scopes (all of the run's by default), or `null`. */
  private async find(
    id: string,
    labels: readonly string[] = this.labels,
  ): Promise<AgentMemoryRecord | null> {
    if (typeof id !== "string" || id === "") return null;
    const record = await AgentMemories.store.get(id);
    if (!record) return null;
    const label = this.labelOf(record.scope);
    return label !== undefined && labels.includes(label) ? record : null;
  }

  private spend(): void {
    if (this.writes.count >= this.limits.maxWritesPerRun) {
      throw new ToolError(
        `This conversation has already saved or deleted ${this.limits.maxWritesPerRun} memories in this turn, the most it may. Carry on without saving more.`,
        { retryable: false },
      );
    }
    this.writes.count++;
  }

  /**
   * One write the run makes: checked, counted, then `writeMemory`. Every
   * failure is a `ToolError` written for the model.
   */
  private async write(
    params: {
      scope: string;
      kind: string;
      content: string;
      key?: string;
      replaces?: string;
      tags: string[];
      pinned?: boolean;
    },
    source: { by: AgentMemorySource["by"]; messageId?: string },
    mode: { modelWrite: boolean },
  ): Promise<{ record: AgentMemoryRecord; action: AgentMemoryWriteAction }> {
    const scopeKey = this.keyOf(params.scope);
    if (mode.modelWrite) {
      if (!this.writableLabels().includes(params.scope)) {
        throw new ToolError(`The ${params.scope} memory is read-only.`, { retryable: false });
      }
      if (!this.kindsFor(params.scope).includes(params.kind)) {
        throw new ToolError(
          `The ${params.scope} memory takes ${this.kindsFor(params.scope).join(", ")} notes, not "${params.kind}".`,
        );
      }
    } else if (!MEMORY_KIND_PATTERN.test(params.kind)) {
      throw new ToolError(`"${params.kind}" is not a memory kind.`, { retryable: false });
    }

    const content = oneLine(params.content ?? "");
    if (content === "") throw new ToolError("The note is empty.");
    if (content.length > this.limits.maxChars) {
      throw new ToolError(
        `The note is ${content.length} characters; a note may have at most ${this.limits.maxChars}. Shorten it, or split it into separate facts.`,
      );
    }
    const secret = secretIn(content);
    if (secret) {
      throw new ToolError(
        `The note looks like it contains ${secret}. Secrets are never saved to memory; leave it out.`,
        { retryable: false },
      );
    }
    const key = params.key === undefined || params.key === null || params.key === "" ? null : params.key;
    if (key !== null && !MEMORY_KEY_PATTERN.test(key)) {
      throw new ToolError(
        `"${key}" is not a usable key: letters, digits and . _ : - only, at most 100 characters.`,
      );
    }
    const tags = [...new Set(params.tags)];
    if (tags.length > MAX_MEMORY_TAGS || tags.some((tag) => !MEMORY_TAG_PATTERN.test(tag))) {
      throw new ToolError(
        `Tags are at most ${MAX_MEMORY_TAGS} short labels of letters, digits and . _ : - each.`,
      );
    }

    let replaces: AgentMemoryRecord | undefined;
    if (params.replaces !== undefined && params.replaces !== null && params.replaces !== "") {
      const target = await this.find(params.replaces, [params.scope]);
      if (!target) throw notFound(params.replaces);
      replaces = target;
    }

    const store = AgentMemories.store;
    if (!replaces) {
      const existing = await store.list([scopeKey]);
      const keyed = key === null ? undefined : existing.find((record) => record.key === key);
      if (!keyed) {
        // The same note saved again, worded the same: nothing to write.
        const same = existing.find(
          (record) =>
            record.kind === params.kind &&
            normalizedContent(record.content) === normalizedContent(content),
        );
        if (same) return { record: same, action: "unchanged" };
        if (existing.length >= this.limits.maxPerScope) {
          throw new ToolError(
            `The ${params.scope} memory is full (${this.limits.maxPerScope} notes). Forget a note that is outdated first, or update one with the same key.`,
            { retryable: false },
          );
        }
      }
    }

    this.spend();
    try {
      return await writeMemory(
        {
          scope: scopeKey,
          kind: params.kind,
          content,
          key: key ?? replaces?.key ?? null,
          tags: tags.length > 0 ? tags : (replaces?.tags ?? []),
          pinned: params.pinned ?? replaces?.pinned ?? false,
          expiresAt: replaces?.expiresAt ?? null,
          source: {
            by: source.by,
            agent: this.origin.agent,
            runId: this.origin.runId,
            ...(this.origin.threadId ? { threadId: this.origin.threadId } : {}),
            ...(source.messageId ? { messageId: source.messageId } : {}),
          },
        },
        replaces ? { replaces } : {},
      );
    } catch (error) {
      if (error instanceof AgentMemoryRefusedError) {
        throw new ToolError(error.message, { retryable: false });
      }
      throw error;
    }
  }
}

function notFound(id: string): ToolError {
  return new ToolError(`There is no memory with the id ${JSON.stringify(id)}.`, {
    retryable: false,
  });
}

/** `ctx.memory` for a call with no run memory at all (a remote MCP call). */
export function noToolMemory(): ToolMemory {
  return new RunMemory({ options: undefined, scopes: undefined, agent: "", runId: "" }).handle();
}
