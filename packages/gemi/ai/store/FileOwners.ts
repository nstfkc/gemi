/**
 * WHO UPLOADED A PROVIDER FILE (#443).
 *
 * A provider's file id (`file-…`) is scoped to the OpenAI/Azure org, not to
 * any user of the app: the vendor will hand the document to whichever request
 * names it. So an id is a bearer token for the file, and ids leak — a shared
 * transcript, a log line, a browser history entry. Before this, a user who
 * learned another user's id could put it in their own `turn.files` and have
 * the model read the other user's document.
 *
 * `AgentController.upload` now records the id with the uploader's owner key
 * (the same `runOwner(req)` that owns a run, #442), and `stream` refuses a
 * turn naming an id recorded for anyone else with a 403.
 *
 * A record is `{ owner, name, mimeType, size, createdAt }`, keyed by the
 * provider's id. `owner: null` is an anonymous upload and is unowned: it
 * answers whoever holds the id, exactly as every id did before this existed.
 */
export type FileOwnerRecord = {
  /** `runOwner(req)` at upload: `user:<id>` by default, `null` for anonymous. */
  owner: string | null;
  name?: string;
  mimeType?: string;
  size?: number;
  createdAt: string;
};

/**
 * Where the records live. Two methods so an app can put them in its own table:
 *
 *   class DbFileOwners implements FileOwners {
 *     async record(fileId, record) { await db.agentFile.create({ data: { fileId, ...record } }) }
 *     async get(fileId) { return db.agentFile.findUnique({ where: { fileId } }) }
 *   }
 *
 * `get` answers `null` for an id it has no record of. What the controller does
 * with that is `AgentController.requireKnownFiles`.
 */
export interface FileOwners {
  record(fileId: string, record: FileOwnerRecord): Promise<void>;
  get(fileId: string): Promise<FileOwnerRecord | null>;
}

/**
 * The default: records last as long as the process, like `MemoryAgentStore`
 * and `MemoryAttachmentStore`. Bounded, oldest first, so an upload loop cannot
 * grow it without end; an evicted id reads as unknown.
 *
 * A record is never overwritten: the first owner of an id keeps it, so a
 * second `record` for the same id (which a provider never mints, but a buggy
 * or hostile override could forward) cannot move a file to another user.
 */
export class MemoryFileOwners implements FileOwners {
  private readonly records = new Map<string, FileOwnerRecord>();

  constructor(private readonly maxEntries = 100_000) {}

  async record(fileId: string, record: FileOwnerRecord): Promise<void> {
    if (this.records.has(fileId)) return;
    this.records.set(fileId, { ...record });
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  async get(fileId: string): Promise<FileOwnerRecord | null> {
    const record = this.records.get(fileId);
    return record ? { ...record } : null;
  }
}

export const defaultFileOwners = new MemoryFileOwners();
