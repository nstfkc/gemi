import { LockLostError, type LockStore } from "./LockStore";

type Entry = {
  owner: string;
  token: number;
  expiresAt: number;
  /** Running `fence` calls. A fenced lock cannot change hands, lease or not. */
  fences: number;
};

/**
 * Locks in this process's memory. Correct for one process and useless across
 * several: two servers each have their own map, so each takes every lock. It
 * is what the queue uses with the memory driver, and in tests.
 */
export class MemoryLockStore implements LockStore {
  private readonly entries = new Map<string, Entry>();
  private readonly counters = new Map<string, number>();

  async acquire(name: string, owner: string, ttlMs: number): Promise<number | null> {
    const now = Date.now();
    const entry = this.entries.get(name);
    if (entry && (entry.expiresAt > now || entry.fences > 0)) return null;
    const token = (entry?.token ?? 0) + 1;
    this.entries.set(name, { owner, token, expiresAt: now + Math.max(0, ttlMs), fences: 0 });
    return token;
  }

  async extend(name: string, owner: string, token: number, ttlMs: number): Promise<boolean> {
    const entry = this.current(name, owner, token);
    if (!entry) return false;
    entry.expiresAt = Date.now() + Math.max(0, ttlMs);
    return true;
  }

  async release(name: string, owner: string, token?: number): Promise<boolean> {
    const entry = this.current(name, owner, token);
    if (!entry) return false;
    entry.owner = "";
    entry.expiresAt = 0;
    return true;
  }

  async holder(name: string) {
    const entry = this.entries.get(name);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return { owner: entry.owner, token: entry.token };
  }

  async held(name: string, owner: string, token: number): Promise<boolean> {
    return this.current(name, owner, token) !== undefined;
  }

  async advance(name: string, value: number): Promise<boolean> {
    if ((this.counters.get(name) ?? -Infinity) >= value) return false;
    this.counters.set(name, value);
    return true;
  }

  async fence<T>(name: string, owner: string, token: number, fn: () => Promise<T>): Promise<T> {
    const entry = this.current(name, owner, token);
    if (!entry) throw new LockLostError(name, token);
    entry.fences++;
    try {
      return await fn();
    } finally {
      entry.fences--;
    }
  }

  private current(name: string, owner: string, token?: number) {
    const entry = this.entries.get(name);
    if (!entry || entry.owner !== owner || entry.expiresAt <= Date.now()) return undefined;
    if (token !== undefined && entry.token !== token) return undefined;
    return entry;
  }
}
