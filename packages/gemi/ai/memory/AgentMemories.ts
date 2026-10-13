import {
  type AgentMemoryKind,
  type AgentMemoryListOptions,
  type AgentMemoryRecord,
  type AgentMemorySearchOptions,
  type AgentMemorySource,
  type AgentMemoryStore,
  type AgentMemoryUpdate,
  type AgentMemoryWriteAction,
  InMemoryAgentMemoryStore,
  newMemoryId,
} from "./AgentMemoryStore";

/**
 * A memory about to be written, as `beforeWrite` sees it. Return it (changed
 * or not) to let the write through, or `null` to refuse it.
 */
export type AgentMemoryDraft = {
  /** The scope key. Changing it is refused: a write stays in the scope it was made for. */
  scope: string;
  kind: AgentMemoryKind;
  content: string;
  key: string | null;
  tags: string[];
  pinned: boolean;
  expiresAt: number | null;
  source: AgentMemorySource;
};

/**
 * What `onWrite` hears: a memory added, changed or deleted, or a whole scope
 * erased. A write that changed nothing (`unchanged`) is not reported.
 */
export type AgentMemoryWriteEvent =
  | {
      action: "added" | "updated";
      memory: AgentMemoryRecord;
      by: AgentMemorySource["by"];
    }
  | {
      action: "deleted";
      memory: AgentMemoryRecord;
      by: AgentMemorySource["by"];
      /** What the agent gave as its reason, for a `forget`. */
      reason?: string;
    }
  | {
      action: "scope-deleted";
      scope: string;
      count: number;
      by: AgentMemorySource["by"];
    };

export type AgentMemoriesHooks = {
  /**
   * Called before every write, the agent's and the app's: return the memory
   * to store (changed or not), or `null` to refuse it. An agent is told its
   * write was refused. Where an app adds its own rules: words it never keeps,
   * a scope that is switched off, a stricter length.
   */
  beforeWrite?: (
    memory: AgentMemoryDraft,
    info: { existing: AgentMemoryRecord | null },
  ) => AgentMemoryDraft | null | void | Promise<AgentMemoryDraft | null | void>;
  /**
   * Called after every write that changed something, the agent's and the
   * app's. For a live "what we remember" screen, or an audit log: deletes are
   * hard, and this is the only record of them. A hook that throws is logged
   * and does not undo the write.
   */
  onWrite?: (event: AgentMemoryWriteEvent) => void | Promise<void>;
};

/** What `AgentMemories.put` takes. */
export type AgentMemoryInput = {
  kind: AgentMemoryKind;
  content: string;
  key?: string | null;
  tags?: string[];
  pinned?: boolean;
  expiresAt?: number | null;
  /** Default `{ by: "app" }`. A memory the user typed in a settings screen is `{ by: "user" }`. */
  source?: AgentMemorySource;
};

/** What `AgentMemories.export` answers: everything a scope holds, for a data-access request. */
export type AgentMemoryExport = {
  scope: string;
  /** Epoch milliseconds. */
  exportedAt: number;
  memories: AgentMemoryRecord[];
};

/** `beforeWrite` said no. An agent's tool is told so; the app's own call throws this. */
export class AgentMemoryRefusedError extends Error {
  constructor(message = "The app refused to save this memory.") {
    super(message);
    this.name = "AgentMemoryRefusedError";
  }
}

/** `update` was given a `version` the memory is no longer at: someone else changed it first. */
export class AgentMemoryConflictError extends Error {
  readonly current: AgentMemoryRecord;

  constructor(current: AgentMemoryRecord, expected: number) {
    super(
      `The memory ${current.id} is at version ${current.version}, not ${expected}: it changed since it was read.`,
    );
    this.name = "AgentMemoryConflictError";
    this.current = current;
  }
}

let currentStore: AgentMemoryStore = new InMemoryAgentMemoryStore();
let currentHooks: AgentMemoriesHooks = {};

/**
 * Agent memory outside a run (#936): where memories are kept, and the app's
 * API over them.
 *
 *     AgentMemories.use(new DatabaseAgentMemoryStore(app(DatabaseManager).connection()), {
 *       onWrite: (event) => Broadcast.to(…).emit("memory", event),
 *     });
 *
 *     await AgentMemories.list(`project:${project.publicId}`);
 *     await AgentMemories.deleteScope(`user:${user.publicId}`);
 *
 * Process-wide, like `AgentJobs`, because a settings screen, an account
 * deletion and a queued job have no run to reach it through.
 *
 * NOTHING HERE CHECKS WHO IS ASKING. A scope key is a capability, as a
 * `threadId` is: the app's route decides whether the caller may read or
 * change `project:<id>` before it calls any of these, the same way it does
 * for threads. Inside a run, tools reach memory through `ctx.memory`, which
 * only knows the scopes the server resolved for that run.
 */
export const AgentMemories = {
  /** The store every part of the feature reads and writes. */
  get store(): AgentMemoryStore {
    return currentStore;
  },

  /** The hooks given to `use`. */
  get hooks(): AgentMemoriesHooks {
    return currentHooks;
  },

  /**
   * Sets the store, and the hooks. Call it once, at boot, in every process
   * that runs agents or reads memories. The default is an
   * `InMemoryAgentMemoryStore`, which a restart empties.
   */
  use(store: AgentMemoryStore, hooks: AgentMemoriesHooks = {}): void {
    currentStore = store;
    currentHooks = hooks;
  },

  /** A scope's memories (or several scopes'), oldest first. Paginate with `after`. */
  list(
    scope: string | readonly string[],
    options?: AgentMemoryListOptions,
  ): Promise<AgentMemoryRecord[]> {
    return currentStore.list(typeof scope === "string" ? [scope] : scope, options);
  },

  get(id: string): Promise<AgentMemoryRecord | null> {
    return currentStore.get(id);
  },

  /** Keyword search, best first, as the `recall` tool does it. */
  search(
    scope: string | readonly string[],
    query: string,
    options?: AgentMemorySearchOptions,
  ): Promise<AgentMemoryRecord[]> {
    return currentStore.search(typeof scope === "string" ? [scope] : scope, query, options);
  },

  /**
   * Writes a memory into a scope, as the app (`source.by` defaults to
   * `"app"`): a fact from a form the user filled in, a pin from a settings
   * screen. With a `key` it replaces the memory at that key. Goes through
   * `beforeWrite` and `onWrite`; throws `AgentMemoryRefusedError` when
   * `beforeWrite` refuses it.
   *
   * Not held to the limits an agent's writes are (length, secrets, how many
   * per scope): the app is trusted with its own data. Validate what a user
   * types here as you would any input.
   */
  async put(
    scope: string,
    input: AgentMemoryInput,
  ): Promise<{ record: AgentMemoryRecord; action: AgentMemoryWriteAction }> {
    if (typeof scope !== "string" || scope === "") {
      throw new TypeError("AgentMemories.put needs a scope key.");
    }
    if (typeof input.content !== "string" || input.content.trim() === "") {
      throw new TypeError("AgentMemories.put needs some content.");
    }
    return writeMemory({
      scope,
      kind: input.kind,
      content: input.content,
      key: input.key ?? null,
      tags: input.tags ?? [],
      pinned: input.pinned ?? false,
      expiresAt: input.expiresAt ?? null,
      source: input.source ?? { by: "app" },
    });
  },

  /**
   * Changes a memory. With `{ version }`, only when it is still at that
   * version, which is what a settings screen editing a memory an agent may
   * be changing at the same time passes: a conflict throws
   * `AgentMemoryConflictError` carrying the current memory. `null` when there
   * is no such memory. Goes through `beforeWrite` and `onWrite`.
   */
  async update(
    id: string,
    patch: AgentMemoryUpdate,
    options: { version?: number; by?: AgentMemorySource["by"] } = {},
  ): Promise<AgentMemoryRecord | null> {
    const existing = await currentStore.get(id);
    if (!existing) return null;
    if (options.version !== undefined && existing.version !== options.version) {
      throw new AgentMemoryConflictError(existing, options.version);
    }
    const draft = await applyBeforeWrite(
      {
        scope: existing.scope,
        kind: patch.kind ?? existing.kind,
        content: patch.content ?? existing.content,
        key: patch.key === undefined ? existing.key : patch.key,
        tags: patch.tags ?? existing.tags,
        pinned: patch.pinned ?? existing.pinned,
        expiresAt: patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
        source: existing.source,
      },
      existing,
    );
    const record = await currentStore.update(
      id,
      {
        kind: draft.kind,
        content: draft.content,
        key: draft.key,
        tags: draft.tags,
        pinned: draft.pinned,
        expiresAt: draft.expiresAt,
      },
      options.version ?? existing.version,
    );
    if (!record) {
      const current = await currentStore.get(id);
      if (!current) return null;
      throw new AgentMemoryConflictError(current, options.version ?? existing.version);
    }
    await notify({ action: "updated", memory: record, by: options.by ?? "app" });
    return record;
  },

  /**
   * Hard-deletes memories, and answers how many there were. `onWrite` hears
   * each one. There is no soft delete: what the user erases is gone.
   */
  async delete(
    ids: string | readonly string[],
    options: { by?: AgentMemorySource["by"] } = {},
  ): Promise<number> {
    return deleteMemories(typeof ids === "string" ? [ids] : ids, options.by ?? "app");
  },

  /**
   * Hard-deletes everything a scope holds: an account deletion, an erasure
   * request, "forget everything" in a settings screen.
   */
  async deleteScope(
    scope: string,
    options: { by?: AgentMemorySource["by"] } = {},
  ): Promise<number> {
    const count = await currentStore.deleteScope(scope);
    if (count > 0) {
      await notify({ action: "scope-deleted", scope, count, by: options.by ?? "app" });
    }
    return count;
  },

  /** Everything a scope holds, expired memories included: for a data-access or portability request. */
  async export(scope: string): Promise<AgentMemoryExport> {
    const memories = await currentStore.list([scope], { includeExpired: true });
    return { scope, exportedAt: Date.now(), memories };
  },

  /**
   * Swaps in a `FakeAgentMemoryStore` for a test, and answers it: an
   * in-memory store that records what was written, with assertions. Call
   * `restore()` after the test; a second `fake()` before that answers the
   * same fake.
   */
  fake(): FakeAgentMemoryStore {
    if (currentStore instanceof FakeAgentMemoryStore) return currentStore;
    const fake = new FakeAgentMemoryStore(currentStore, currentHooks);
    currentStore = fake;
    return fake;
  },
};

/**
 * One write, the agent's or the app's: `beforeWrite`, then the store, then
 * `onWrite`. The run's checks (length, secrets, limits) come before this and
 * only for an agent's writes.
 */
export async function writeMemory(
  draft: AgentMemoryDraft,
  options: { replaces?: AgentMemoryRecord } = {},
): Promise<{ record: AgentMemoryRecord; action: AgentMemoryWriteAction }> {
  const store = currentStore;
  const existing =
    options.replaces ??
    (draft.key !== null
      ? ((await store.list([draft.scope])).find((record) => record.key === draft.key) ?? null)
      : null);
  const final = await applyBeforeWrite(draft, existing);

  if (options.replaces) {
    const target = options.replaces;
    const unchanged =
      target.kind === final.kind &&
      target.content === final.content &&
      target.key === final.key &&
      target.pinned === final.pinned &&
      target.expiresAt === final.expiresAt &&
      target.tags.join("\n") === final.tags.join("\n");
    if (unchanged) return { record: target, action: "unchanged" };
    const record = await store.update(target.id, {
      kind: final.kind,
      content: final.content,
      key: final.key,
      tags: final.tags,
      pinned: final.pinned,
      expiresAt: final.expiresAt,
    });
    if (!record) throw new AgentMemoryRefusedError("That memory no longer exists.");
    await notify({ action: "updated", memory: record, by: final.source.by });
    return { record, action: "updated" };
  }

  const result = await store.upsert({
    id: newMemoryId(),
    scope: final.scope,
    kind: final.kind,
    content: final.content,
    key: final.key,
    tags: final.tags,
    pinned: final.pinned,
    expiresAt: final.expiresAt,
    source: final.source,
  });
  if (result.action !== "unchanged") {
    await notify({ action: result.action, memory: result.record, by: final.source.by });
  }
  return result;
}

/** Deletes by id, reporting each to `onWrite`. */
export async function deleteMemories(
  ids: readonly string[],
  by: AgentMemorySource["by"],
  reason?: string,
): Promise<number> {
  const store = currentStore;
  const unique = [...new Set(ids)];
  const records = currentHooks.onWrite
    ? (await Promise.all(unique.map((id) => store.get(id)))).filter(
        (record): record is AgentMemoryRecord => record !== null,
      )
    : [];
  const count = await store.delete(unique);
  for (const memory of records) {
    await notify({ action: "deleted", memory, by, ...(reason ? { reason } : {}) });
  }
  return count;
}

async function applyBeforeWrite(
  draft: AgentMemoryDraft,
  existing: AgentMemoryRecord | null,
): Promise<AgentMemoryDraft> {
  const hook = currentHooks.beforeWrite;
  if (!hook) return draft;
  const answer = await hook(structuredClone(draft), {
    existing: existing ? structuredClone(existing) : null,
  });
  if (answer === null) throw new AgentMemoryRefusedError();
  if (answer === undefined) return draft;
  const final = answer as AgentMemoryDraft;
  if (final.scope !== draft.scope) {
    throw new AgentMemoryRefusedError(
      "beforeWrite moved a memory to another scope; a write stays in the scope it was made for.",
    );
  }
  return final;
}

async function notify(event: AgentMemoryWriteEvent): Promise<void> {
  const hook = currentHooks.onWrite;
  if (!hook) return;
  try {
    await hook(event);
  } catch (error) {
    console.error("[gemi/ai] AgentMemories onWrite threw:", error);
  }
}

/** One write a fake saw. */
export type RecordedMemoryWrite =
  | { action: AgentMemoryWriteAction; record: AgentMemoryRecord }
  | { action: "deleted"; id: string }
  | { action: "scope-deleted"; scope: string };

/**
 * The store `AgentMemories.fake()` installs: an `InMemoryAgentMemoryStore`
 * that also records every write, with assertions for a test. The assertions
 * throw plain `Error`s naming what was written, so they work under any test
 * runner.
 */
export class FakeAgentMemoryStore extends InMemoryAgentMemoryStore {
  /** Every write since the fake was installed, in order. */
  readonly writes: RecordedMemoryWrite[] = [];

  constructor(
    private readonly previous: AgentMemoryStore,
    private readonly previousHooks: AgentMemoriesHooks,
  ) {
    super();
  }

  override async upsert(memory: Parameters<InMemoryAgentMemoryStore["upsert"]>[0]) {
    const result = await super.upsert(memory);
    this.writes.push({ action: result.action, record: result.record });
    return result;
  }

  override async update(id: string, patch: AgentMemoryUpdate, expectedVersion?: number) {
    const record = await super.update(id, patch, expectedVersion);
    if (record) this.writes.push({ action: "updated", record });
    return record;
  }

  override async delete(ids: readonly string[]) {
    const present = (await Promise.all(ids.map((id) => this.get(id)))).filter(Boolean);
    const count = await super.delete(ids);
    for (const record of present) this.writes.push({ action: "deleted", id: record!.id });
    return count;
  }

  override async deleteScope(scope: string) {
    const count = await super.deleteScope(scope);
    this.writes.push({ action: "scope-deleted", scope });
    return count;
  }

  /** Puts back the store and hooks that were there before `fake()`. */
  restore(): void {
    if (currentStore === this) {
      currentStore = this.previous;
      currentHooks = this.previousHooks;
    }
  }

  /**
   * Fails unless a memory was added or updated in `scope` whose content
   * matches: a string it contains, a regular expression, or a predicate over
   * the whole record.
   */
  assertRemembered(
    scope: string,
    match?: string | RegExp | ((record: AgentMemoryRecord) => boolean),
  ): void {
    const found = this.saved().some(
      (record) => record.scope === scope && (match === undefined || matches(record, match)),
    );
    if (found) return;
    throw new Error(
      `Expected a memory to have been saved in "${scope}"${
        match === undefined ? "" : ` matching ${describe(match)}`
      }. ${this.summary()}`,
    );
  }

  /** Fails unless the memory with this id was deleted. */
  assertForgotten(id: string): void {
    if (this.writes.some((write) => write.action === "deleted" && write.id === id)) return;
    throw new Error(`Expected the memory ${id} to have been forgotten. ${this.summary()}`);
  }

  /** Fails if any memory was added or updated. */
  assertNothingRemembered(): void {
    const saved = this.saved();
    if (saved.length === 0) return;
    throw new Error(`Expected no memory to have been saved. ${this.summary()}`);
  }

  private saved(): AgentMemoryRecord[] {
    return this.writes.flatMap((write) =>
      (write.action === "added" || write.action === "updated") && "record" in write
        ? [write.record]
        : [],
    );
  }

  private summary(): string {
    if (this.writes.length === 0) return "Nothing was written.";
    const lines = this.writes.map((write) =>
      "record" in write
        ? `${write.action} ${write.record.id} in "${write.record.scope}": ${JSON.stringify(write.record.content)}`
        : write.action === "deleted"
          ? `deleted ${write.id}`
          : `deleted the scope "${write.scope}"`,
    );
    return `Written:\n  ${lines.join("\n  ")}`;
  }
}

function matches(
  record: AgentMemoryRecord,
  match: string | RegExp | ((record: AgentMemoryRecord) => boolean),
): boolean {
  if (typeof match === "string") return record.content.includes(match);
  if (match instanceof RegExp) return match.test(record.content);
  return match(record);
}

function describe(match: string | RegExp | ((record: AgentMemoryRecord) => boolean)): string {
  if (typeof match === "string") return JSON.stringify(match);
  if (match instanceof RegExp) return String(match);
  return "the predicate";
}
