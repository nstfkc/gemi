/**
 * Concurrency slots (#1319): at most `limit` holders per key, handed out in
 * the order the work first asked, with waiting work parked rather than
 * polling.
 *
 * ### The model
 *
 * Each key has a **line**: the holders of its slots and, behind them, the
 * waiters, ordered by when each first asked (`order`, then the holder's id).
 * A request is granted when the holders plus the waiters ahead of it are
 * fewer than the limit, so work that asked later never overtakes work that
 * asked earlier, however often either is re-admitted. A waiter keeps its
 * place until it is granted or ends.
 *
 * A **holder** is a job (by its id) or a workflow (`workflow:<id>`). Several
 * keys are taken in the order given and all are needed; a waiter for a later
 * key keeps the earlier ones, since it is first in their lines anyway.
 *
 * ### Nothing waits in a process
 *
 * A request that cannot be granted parks its job: the claim goes back to
 * waiting, its attempt taken back, due after `recheckMs` — `near` for a
 * waiter among the first `limit` of its line (at least the first one), `far`
 * for the rest — and in
 * the same atomic step as the decision, so a slot freed a moment later is
 * not missed. Whenever a line has free slots (a holder released, a limit
 * was raised, a holder turned out to be gone), the step that sees it makes
 * the first waiters due at once. The rechecks are only a safety net for a
 * process that died between ending its work and handing its slot on.
 *
 * ### Holders that are gone
 *
 * A slot is never leased. A job's is valid while its job is still waiting
 * or claimed (a crashed holder's job is reclaimed and takes its own slot
 * back), and a workflow's while the workflow is neither ended nor paused.
 * Every step on a line first drops the holders that are no longer valid, so
 * a slot whose release was lost frees itself at the line's next step.
 */
import type { ClaimedJob } from "./QueueDriver";

/** One limit: at most `limit` holders of `key` at once. */
export type SlotLimit = { key: string; limit: number };

export type SlotRequest = {
  /** A job's id, or `workflow:<id>` for a workflow's slots. */
  holder: string;
  /** For a workflow's slots: the workflow, whose status decides whether its slots are still held. */
  workflowId?: string;
  /** The claim that asks: parked when the request is not granted, and woken when its turn comes. */
  job: ClaimedJob;
  /** The limits, taken in this order. */
  slots: SlotLimit[];
  /** When a parked request is claimed again to re-check, in milliseconds. */
  recheckMs: { near: number; far: number };
};

/** The holder a workflow's slots are kept under. */
export function workflowHolder(workflowId: string): string {
  return `workflow:${workflowId}`;
}

/** The longest key a slot may have: it is a VARCHAR(191) column on MySQL. */
export const SLOT_KEY_LIMIT = 191;

/**
 * What a job's or a workflow's `concurrency` returned, checked: one limit or
 * a list, `undefined` or `null` for none. Throws, on the caller's attempt,
 * for a key or a limit the line could not hold.
 */
export function slotLimits(value: unknown, owner: string): SlotLimit[] {
  if (value === undefined || value === null) return [];
  const list = (Array.isArray(value) ? value : [value]) as unknown[];
  const seen = new Set<string>();
  const limits: SlotLimit[] = [];
  for (const entry of list) {
    if (entry === undefined || entry === null) continue;
    const { key, limit } = (entry ?? {}) as { key?: unknown; limit?: unknown };
    if (typeof key !== "string" || key.length === 0 || key.length > SLOT_KEY_LIMIT) {
      throw new TypeError(
        `${owner}.concurrency returned a key that is not a string of 1 to ` +
          `${SLOT_KEY_LIMIT} characters: ${JSON.stringify(key)}.`,
      );
    }
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
      throw new TypeError(
        `${owner}.concurrency returned the limit ${String(limit)} for "${key}"; ` +
          `a limit is a whole number, 0 or more.`,
      );
    }
    if (seen.has(key)) {
      throw new TypeError(`${owner}.concurrency returned the key "${key}" twice.`);
    }
    seen.add(key);
    limits.push({ key, limit });
  }
  return limits;
}

/** What `MemorySlots` needs from the memory driver, all synchronous. */
export type MemorySlotHost = {
  /** Whether the job is still waiting or claimed. */
  jobAlive(id: string): boolean;
  /** Whether the workflow exists and is neither ended nor paused. */
  workflowAlive(id: string): boolean;
  /** Puts a current claim back to waiting, due after `ms`, its attempt taken back. */
  park(job: ClaimedJob, ms: number): void;
  /** Makes a waiting job due now; `false` when there is no such job. */
  wake(id: string): boolean;
  /** Enqueues a tick for the workflow, and returns its job id. */
  tick(workflowId: string): string;
};

type Ticket = {
  holder: string;
  state: "waiting" | "holding";
  order: number;
  jobId: string;
  workflowId: string | undefined;
};

type Line = { key: string; limit: number; tickets: Map<string, Ticket> };

/**
 * The lines in this process's memory, for the memory driver: the same
 * order, parking and waking as the database driver's, and like everything
 * on that driver, per process.
 */
export class MemorySlots {
  private lines = new Map<string, Line>();
  private keysOf = new Map<string, Set<string>>();
  private order = 0;

  constructor(private readonly host: MemorySlotHost) {}

  /** Holders and waiters of `key`, for tests. */
  line(key: string): { holding: string[]; waiting: string[] } {
    const line = this.lines.get(key);
    const tickets = line ? this.sorted(line) : [];
    return {
      holding: tickets.filter((t) => t.state === "holding").map((t) => t.holder),
      waiting: tickets.filter((t) => t.state === "waiting").map((t) => t.holder),
    };
  }

  acquire(request: SlotRequest): boolean {
    let order: number | undefined;
    for (const key of this.keysOf.get(request.holder) ?? []) {
      const ticket = this.lines.get(key)?.tickets.get(request.holder);
      if (ticket && (order === undefined || ticket.order < order)) order = ticket.order;
    }
    order ??= this.order++;

    for (const { key, limit } of request.slots) {
      const line = this.lines.get(key) ?? { key, limit, tickets: new Map() };
      this.lines.set(key, line);
      line.limit = limit;
      this.prune(line);

      let ticket = line.tickets.get(request.holder);
      if (!ticket) {
        ticket = {
          holder: request.holder,
          state: "waiting",
          order,
          jobId: request.job.id,
          workflowId: request.workflowId,
        };
        line.tickets.set(request.holder, ticket);
        const keys = this.keysOf.get(request.holder) ?? new Set();
        keys.add(key);
        this.keysOf.set(request.holder, keys);
      }
      ticket.jobId = request.job.id;

      const grantable = () => this.holders(line) + this.ahead(line, ticket) < limit;
      if (ticket.state === "waiting" && !grantable()) {
        // Waking drops the dead waiters ahead, which may leave room.
        this.wake(line, request.holder);
      }
      if (ticket.state === "waiting" && grantable()) ticket.state = "holding";
      if (ticket.state === "holding") {
        // A raised limit, or holders that were gone, can leave room behind this one too.
        this.wake(line, request.holder);
        continue;
      }

      // The first waiter re-checks soon even under a limit of 0, so a limit
      // raised while nothing else happens on the key is seen.
      const near = this.ahead(line, ticket) < Math.max(1, limit);
      this.host.park(request.job, near ? request.recheckMs.near : request.recheckMs.far);
      return false;
    }
    return true;
  }

  release(holder: string): void {
    const keys = this.keysOf.get(holder);
    if (!keys) return;
    this.keysOf.delete(holder);
    for (const key of keys) {
      const line = this.lines.get(key);
      if (!line) continue;
      line.tickets.delete(holder);
      this.prune(line);
      this.wake(line, holder);
      if (line.tickets.size === 0) this.lines.delete(key);
    }
  }

  private sorted(line: Line): Ticket[] {
    return [...line.tickets.values()].sort(
      (a, b) => a.order - b.order || (a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0),
    );
  }

  private holders(line: Line): number {
    let count = 0;
    for (const ticket of line.tickets.values()) if (ticket.state === "holding") count++;
    return count;
  }

  private ahead(line: Line, ticket: Ticket): number {
    let count = 0;
    for (const other of line.tickets.values()) {
      if (other.state !== "waiting" || other === ticket) continue;
      if (
        other.order < ticket.order ||
        (other.order === ticket.order && other.holder < ticket.holder)
      ) {
        count++;
      }
    }
    return count;
  }

  private alive(ticket: Ticket): boolean {
    return ticket.workflowId !== undefined
      ? this.host.workflowAlive(ticket.workflowId)
      : this.host.jobAlive(ticket.jobId);
  }

  /** Drops holders whose job or workflow is gone. */
  private prune(line: Line) {
    for (const ticket of line.tickets.values()) {
      if (ticket.state === "holding" && !this.alive(ticket)) this.forget(line, ticket);
    }
  }

  /** Makes the first waiters due, as many as the line has free slots, dropping dead ones. */
  private wake(line: Line, except: string) {
    let free = line.limit - this.holders(line);
    for (const ticket of this.sorted(line)) {
      if (free <= 0) return;
      if (ticket.state !== "waiting" || ticket.holder === except) continue;
      if (!this.alive(ticket)) {
        this.forget(line, ticket);
        continue;
      }
      if (!this.host.wake(ticket.jobId)) {
        if (ticket.workflowId === undefined) {
          this.forget(line, ticket);
          continue;
        }
        // A workflow whose parked tick is gone gets a new one.
        ticket.jobId = this.host.tick(ticket.workflowId);
      }
      free--;
    }
  }

  private forget(line: Line, ticket: Ticket) {
    line.tickets.delete(ticket.holder);
    const keys = this.keysOf.get(ticket.holder);
    keys?.delete(line.key);
    if (keys?.size === 0) this.keysOf.delete(ticket.holder);
  }
}
