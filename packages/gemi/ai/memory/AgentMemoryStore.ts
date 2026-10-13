import { rankMemories } from "./search";

/**
 * What a memory is about (#936). `fact`, `preference`, `episode` and `note`
 * are the ones gemi knows; an app may use strings of its own.
 *
 * - `fact`: something true about the user or their project ("Open Tue–Sun 8–16").
 * - `preference`: how they want things done ("never use stock photos of people").
 * - `episode`: a summary of past work. Written by the extractor (a later phase).
 * - `note`: a working note, usually in a thread scope.
 */
export type AgentMemoryKind = "fact" | "preference" | "episode" | "note" | (string & {});

/** Who wrote a memory, and from where. Kept for the UI ("saved from this message") and for audits. */
export type AgentMemorySource = {
  by: "agent" | "extractor" | "app" | "user";
  /** The agent whose run wrote it. */
  agent?: string;
  runId?: string;
  threadId?: string;
  /** The assistant message holding the tool call that wrote it. */
  messageId?: string;
};

/**
 * One memory, as the store keeps it (#936).
 *
 * A short, self-contained note that belongs to exactly one scope. The scope is
 * the app's key (`project:clx…`, `user:42`), decided on the server for each
 * run; the model only ever sees the scope's label (`project`) and never this.
 */
export type AgentMemoryRecord = {
  /** `mem_…`. */
  id: string;
  /** The app's key, e.g. `project:clx…`. */
  scope: string;
  kind: AgentMemoryKind;
  /** One sentence or a short paragraph. Agents' writes are capped (500 chars by default). */
  content: string;
  /**
   * A stable slot in the scope, e.g. `business.hours`: a write with the same
   * scope and key replaces the memory there rather than adding another one.
   * `null` for a memory without one.
   */
  key: string | null;
  /** The app's routing labels, e.g. `["pictures"]`. Empty when there are none. */
  tags: string[];
  /** Always listed first in the `<memory>` block. */
  pinned: boolean;
  source: AgentMemorySource;
  /** Starts at 1 and goes up on every change. `update` compares against it. */
  version: number;
  /** Epoch milliseconds, on the store's clock. */
  createdAt: number;
  updatedAt: number;
  /** When an agent last read it. Kept up to date in a later phase (#936 P2). */
  lastUsedAt: number | null;
  /** When it stops being listed, and `prune` may delete it. `null` for never. */
  expiresAt: number | null;
};

/** What `upsert` is given: the record minus what the store stamps. */
export type NewAgentMemoryRecord = {
  id: string;
  scope: string;
  kind: AgentMemoryKind;
  content: string;
  key?: string | null;
  tags?: string[];
  pinned?: boolean;
  source: AgentMemorySource;
  expiresAt?: number | null;
};

/** The fields `update` may change. The id, the scope and the source never change. */
export type AgentMemoryUpdate = Partial<
  Pick<AgentMemoryRecord, "kind" | "content" | "key" | "tags" | "pinned" | "expiresAt">
>;

/** What a write did. `unchanged` when the memory was already there as written. */
export type AgentMemoryWriteAction = "added" | "updated" | "unchanged";

export type AgentMemoryListOptions = {
  /** Only these kinds. */
  kinds?: readonly string[];
  /** Only memories carrying at least one of these tags. */
  tags?: readonly string[];
  /** At most this many. */
  limit?: number;
  /**
   * The id of the last memory of the previous page: the list goes on after
   * it. Ignored when that memory is gone or is in none of the scopes.
   */
  after?: string;
  /** List memories past their `expiresAt` too. Default `false`. */
  includeExpired?: boolean;
};

export type AgentMemorySearchOptions = {
  kinds?: readonly string[];
  tags?: readonly string[];
  /** Default 8. */
  limit?: number;
};

/**
 * Where agent memories live (#936).
 *
 * `InMemoryAgentMemoryStore` is the default and is not durable.
 * `DatabaseAgentMemoryStore` keeps them in a table of the app's database. An
 * app with a table of its own can implement this over it; the conformance
 * tests in `ai/memory/stores.test.ts` say what each method must do.
 *
 * Every method that lists takes scope keys, never labels. Turning a label
 * into a key is the run's job, and nothing the model writes reaches here as
 * a key.
 */
export interface AgentMemoryStore {
  /**
   * The scopes' memories, oldest first (`createdAt`, then `id`). Expired ones
   * are left out unless `includeExpired`.
   */
  list(scopes: readonly string[], options?: AgentMemoryListOptions): Promise<AgentMemoryRecord[]>;
  get(id: string): Promise<AgentMemoryRecord | null>;
  /**
   * Writes a memory. With a `key`, it replaces the memory already at that
   * scope and key (`updated`, its version bumped and its id kept), or answers
   * `unchanged` when nothing differs. Without one it always adds.
   */
  upsert(
    memory: NewAgentMemoryRecord,
  ): Promise<{ record: AgentMemoryRecord; action: AgentMemoryWriteAction }>;
  /**
   * Changes a memory and bumps its version. With `expectedVersion`, only when
   * the memory is still at that version (compare-and-set). `null` when there
   * is no such memory, or its version differs.
   */
  update(
    id: string,
    patch: AgentMemoryUpdate,
    expectedVersion?: number,
  ): Promise<AgentMemoryRecord | null>;
  /** Hard-deletes them, and answers how many were there. */
  delete(ids: readonly string[]): Promise<number>;
  /** Hard-deletes every memory of a scope, and answers how many. */
  deleteScope(scope: string): Promise<number>;
  /**
   * The scopes' memories that match `query` best, best first: keyword search
   * (BM25 over the content, key and tags) in P1. A store may answer with a
   * search of its own (full text, embeddings).
   */
  search(
    scopes: readonly string[],
    query: string,
    options?: AgentMemorySearchOptions,
  ): Promise<AgentMemoryRecord[]>;
  /** How many unexpired memories a scope holds. */
  count(scope: string): Promise<number>;
  /** Stamps `lastUsedAt`. Optional; used by a later phase (#936 P2). */
  touch?(ids: readonly string[], at: number): Promise<void>;
  /** Deletes memories whose `expiresAt` is at or before `now`, and answers how many. */
  prune?(now: number): Promise<number>;
}

let lastIdTime = 0;

/**
 * A new memory id, ordered by creation within a process: the time in
 * milliseconds (moved on by one when two ids land in the same one), then
 * random characters. Ids are the tie-break when two memories share a
 * `createdAt`, so this keeps "oldest first" in the order they were written.
 */
export function newMemoryId(): string {
  lastIdTime = Math.max(Date.now(), lastIdTime + 1);
  const random = crypto.getRandomValues(new Uint8Array(6));
  let tail = "";
  for (const byte of random) tail += (byte % 36).toString(36);
  return `mem_${lastIdTime.toString(36).padStart(9, "0")}${tail}`;
}

/** Oldest first, with the id as a tie-break so the order is stable. */
export function oldestFirst(a: AgentMemoryRecord, b: AgentMemoryRecord): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Whether `record` carries one of `tags`. No filter matches everything. */
export function hasAnyTag(record: AgentMemoryRecord, tags: readonly string[] | undefined): boolean {
  if (tags === undefined) return true;
  return record.tags.some((tag) => tags.includes(tag));
}

/** Whether two writes would store the same memory. */
export function sameMemory(record: AgentMemoryRecord, memory: NewAgentMemoryRecord): boolean {
  return (
    record.kind === memory.kind &&
    record.content === memory.content &&
    record.pinned === (memory.pinned ?? false) &&
    record.expiresAt === (memory.expiresAt ?? null) &&
    sameTags(record.tags, memory.tags ?? [])
  );
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, at) => tag === b[at]);
}

/**
 * Memories in a map, for as long as the process lives.
 *
 * NOT DURABLE, like `MemoryAgentStore`: a restart forgets everything. It is
 * the default so that memory works in development and tests without a table;
 * use `DatabaseAgentMemoryStore` in production. (Named `InMemory…` rather
 * than `Memory…`, which would make it a `MemoryAgentMemoryStore`.)
 */
export class InMemoryAgentMemoryStore implements AgentMemoryStore {
  private memories = new Map<string, AgentMemoryRecord>();

  async list(
    scopes: readonly string[],
    options: AgentMemoryListOptions = {},
  ): Promise<AgentMemoryRecord[]> {
    const now = Date.now();
    let out = [...this.memories.values()]
      .filter(
        (record) =>
          scopes.includes(record.scope) &&
          (options.kinds === undefined || options.kinds.includes(record.kind)) &&
          hasAnyTag(record, options.tags) &&
          (options.includeExpired || record.expiresAt === null || record.expiresAt > now),
      )
      .sort(oldestFirst);
    const cursor = options.after === undefined ? undefined : this.memories.get(options.after);
    if (cursor && scopes.includes(cursor.scope)) {
      out = out.filter((record) => oldestFirst(record, cursor) > 0);
    }
    if (options.limit !== undefined) out = out.slice(0, Math.max(0, Math.floor(options.limit)));
    return out.map((record) => structuredClone(record));
  }

  async get(id: string): Promise<AgentMemoryRecord | null> {
    const record = this.memories.get(id);
    return record ? structuredClone(record) : null;
  }

  async upsert(
    memory: NewAgentMemoryRecord,
  ): Promise<{ record: AgentMemoryRecord; action: AgentMemoryWriteAction }> {
    const now = Date.now();
    const key = memory.key ?? null;
    if (key !== null) {
      const existing = [...this.memories.values()].find(
        (record) => record.scope === memory.scope && record.key === key,
      );
      if (existing) {
        if (sameMemory(existing, memory)) {
          return { record: structuredClone(existing), action: "unchanged" };
        }
        Object.assign(existing, {
          kind: memory.kind,
          content: memory.content,
          tags: [...(memory.tags ?? [])],
          pinned: memory.pinned ?? false,
          expiresAt: memory.expiresAt ?? null,
          version: existing.version + 1,
          updatedAt: Math.max(now, existing.updatedAt),
        });
        return { record: structuredClone(existing), action: "updated" };
      }
    }
    if (this.memories.has(memory.id)) {
      throw new Error(`A memory with the id ${memory.id} already exists.`);
    }
    const record: AgentMemoryRecord = {
      id: memory.id,
      scope: memory.scope,
      kind: memory.kind,
      content: memory.content,
      key,
      tags: [...(memory.tags ?? [])],
      pinned: memory.pinned ?? false,
      source: structuredClone(memory.source),
      version: 1,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      expiresAt: memory.expiresAt ?? null,
    };
    this.memories.set(record.id, record);
    return { record: structuredClone(record), action: "added" };
  }

  async update(
    id: string,
    patch: AgentMemoryUpdate,
    expectedVersion?: number,
  ): Promise<AgentMemoryRecord | null> {
    const record = this.memories.get(id);
    if (!record) return null;
    if (expectedVersion !== undefined && record.version !== expectedVersion) return null;
    const key = patch.key === undefined ? record.key : patch.key;
    if (
      key !== null &&
      key !== record.key &&
      [...this.memories.values()].some((other) => other.scope === record.scope && other.key === key)
    ) {
      throw new Error(`The scope already has a memory with the key "${key}".`);
    }
    const update = structuredClone(patch);
    for (const field of Object.keys(update) as (keyof AgentMemoryUpdate)[]) {
      if (update[field] === undefined) delete update[field];
    }
    Object.assign(record, update, {
      version: record.version + 1,
      updatedAt: Math.max(Date.now(), record.updatedAt),
    });
    return structuredClone(record);
  }

  async delete(ids: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const id of new Set(ids)) if (this.memories.delete(id)) deleted++;
    return deleted;
  }

  async deleteScope(scope: string): Promise<number> {
    let deleted = 0;
    for (const record of this.memories.values()) {
      if (record.scope === scope && this.memories.delete(record.id)) deleted++;
    }
    return deleted;
  }

  async search(
    scopes: readonly string[],
    query: string,
    options: AgentMemorySearchOptions = {},
  ): Promise<AgentMemoryRecord[]> {
    const rows = await this.list(scopes, { kinds: options.kinds, tags: options.tags });
    return rankMemories(rows, query, options.limit);
  }

  async count(scope: string): Promise<number> {
    return (await this.list([scope])).length;
  }

  async touch(ids: readonly string[], at: number): Promise<void> {
    for (const id of ids) {
      const record = this.memories.get(id);
      if (record) record.lastUsedAt = at;
    }
  }

  async prune(now: number): Promise<number> {
    let deleted = 0;
    for (const record of this.memories.values()) {
      if (record.expiresAt !== null && record.expiresAt <= now) {
        this.memories.delete(record.id);
        deleted++;
      }
    }
    return deleted;
  }
}
