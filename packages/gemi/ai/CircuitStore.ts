/**
 * Where a `FallbackProvider` keeps its circuit state (#742): which legs have
 * failed enough in a row to be skipped for a while.
 *
 * IN-PROCESS BY DEFAULT, AND ON PURPOSE. The breaker exists so one process
 * stops paying a dead primary's timeout on every call; each instance learning
 * that on its own costs `failures` slow calls per instance per cool-down, which
 * is small next to what it saves. Sharing the state would save those few calls
 * at the price of a store round trip on every model call, and the store gemi
 * already shares between instances (`LockStore`, #738/#739) cannot express this
 * model without approximating it: it has no way to read or reset a counter, so
 * "N failures in a row, reset by a success" becomes "N failures in a window",
 * and the single half-open probe becomes every instance probing at once. An
 * app that wants shared state implements this interface over its own store.
 *
 * ### The model
 *
 * A key is **closed** until `policy.failures` failures are recorded in a row,
 * then **open** for `policy.cooldownMs`: `allow` says no. After the cool-down
 * the next `allow` lets ONE call through as a probe (half-open) and says no to
 * everyone else while it runs. The probe's success closes the circuit, its
 * failure opens it again for another cool-down, and a probe that never reports
 * back (its caller stopped reading) is given up on after `cooldownMs`.
 */
export type CircuitPolicy = {
  /** Failures in a row that open the circuit. */
  failures: number;
  /** How long an open circuit stays open, in milliseconds. */
  cooldownMs: number;
};

/**
 * What a leg's call came to, for the breaker:
 *
 * - `success`: the leg answered, or started to (output reached the consumer).
 * - `failure`: it failed in a way the chain falls back on.
 * - `none`: neither says anything about the leg's health — the user aborted,
 *   or the request was refused for a reason any model would refuse it for.
 */
export type CircuitOutcome = "success" | "failure" | "none";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitStore {
  /** Whether a call may go to `key` now. A `true` in the half-open state makes
   *  that call the probe, so call it only when the leg will then be tried. */
  allow(key: string, policy: CircuitPolicy): boolean | Promise<boolean>;
  /** Records how an allowed call went. Resolves to the state the key moved to,
   *  or `undefined` when it did not change. */
  record(
    key: string,
    outcome: CircuitOutcome,
    policy: CircuitPolicy,
  ): CircuitState | undefined | Promise<CircuitState | undefined>;
}

type Entry = {
  failures: number;
  /** Set while open or half-open: when the cool-down ends. */
  openUntil?: number;
  /** Set while a half-open probe is out: when it is given up on. */
  probeUntil?: number;
};

/** The default `CircuitStore`: a map in this process. */
export class MemoryCircuitStore implements CircuitStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  allow(key: string, policy: CircuitPolicy): boolean {
    const entry = this.entries.get(key);
    if (entry?.openUntil === undefined) return true;
    const now = this.now();
    if (now < entry.openUntil) return false;
    if (entry.probeUntil !== undefined && now < entry.probeUntil) return false;
    entry.probeUntil = now + policy.cooldownMs;
    return true;
  }

  record(key: string, outcome: CircuitOutcome, policy: CircuitPolicy): CircuitState | undefined {
    const entry = this.entries.get(key) ?? { failures: 0 };
    const wasOpen = entry.openUntil !== undefined;

    if (outcome === "success") {
      this.entries.delete(key);
      return wasOpen ? "closed" : undefined;
    }
    if (outcome === "none") {
      // A probe that learned nothing frees the slot for the next call.
      delete entry.probeUntil;
      return undefined;
    }

    entry.failures += 1;
    this.entries.set(key, entry);
    // Half-open: one failure is enough. Closed: `failures` in a row.
    if (wasOpen || entry.failures >= policy.failures) {
      entry.openUntil = this.now() + policy.cooldownMs;
      delete entry.probeUntil;
      return wasOpen ? undefined : "open";
    }
    return undefined;
  }

  /** The state of `key` right now, for tests and dashboards. */
  state(key: string): CircuitState {
    const entry = this.entries.get(key);
    if (entry?.openUntil === undefined) return "closed";
    return this.now() < entry.openUntil ? "open" : "half-open";
  }
}
