import type { VoiceEndReason } from "./voice/wire";

/**
 * A voice session's state, outside the process that holds its sideband (#921).
 *
 * A `PATCH` (the selection changed) or a `DELETE` (the user pressed End) can
 * land on any instance behind a load balancer. The instance that answers it
 * reads and writes the session here; the instance holding the sideband reads
 * the latest `body` before every delegated turn. Ending does not need the
 * holder at all: whoever answers the `DELETE` hangs the call up at the vendor,
 * and the holder's sideband sees the call close.
 *
 * Small and JSON-shaped on purpose, so a database or Redis implementation is a
 * page of code. `MemoryVoiceSessionStore` is the process-local default.
 */
export type VoiceSessionRecord = {
  id: string;
  /** The vendor's call id. */
  callId: string;
  threadId: string;
  /** `runOwner` of the request that started it; `null` is nobody. */
  owner: string | null;
  /** The controller's `Body`, as last sent. */
  body: Record<string, unknown>;
  /** Epoch ms. */
  startedAt: number;
  endedAt?: number;
  endReason?: VoiceEndReason;
};

export interface VoiceSessionStore {
  create(record: VoiceSessionRecord): Promise<void>;
  get(id: string): Promise<VoiceSessionRecord | null>;
  /** Merges `patch` into the record. A missing record is not an error. */
  update(id: string, patch: Partial<Omit<VoiceSessionRecord, "id">>): Promise<void>;
}

/**
 * Process-local. Ended sessions are dropped after `retainEndedMs` (default 10
 * minutes), so a long-lived process does not keep every call it ever had.
 */
export class MemoryVoiceSessionStore implements VoiceSessionStore {
  private readonly records = new Map<string, VoiceSessionRecord>();
  private readonly retainEndedMs: number;

  constructor(options: { retainEndedMs?: number } = {}) {
    this.retainEndedMs = options.retainEndedMs ?? 10 * 60_000;
  }

  async create(record: VoiceSessionRecord): Promise<void> {
    this.sweep();
    this.records.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<VoiceSessionRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async update(id: string, patch: Partial<Omit<VoiceSessionRecord, "id">>): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    this.records.set(id, { ...record, ...structuredClone(patch), id });
  }

  private sweep(): void {
    const cutoff = Date.now() - this.retainEndedMs;
    for (const [id, record] of this.records) {
      if (record.endedAt !== undefined && record.endedAt < cutoff) this.records.delete(id);
    }
  }
}

/** The store `AgentController.voiceStore` uses unless an app sets another. */
export const defaultVoiceStore = new MemoryVoiceSessionStore();
