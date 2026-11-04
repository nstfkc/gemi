/**
 * Usage limits for agent runs (#1124): budgets on what a run, and a key the
 * app chooses (a user, a tenant, a billing period), may spend, checked as the
 * run goes, with a hook that hears what was spent.
 *
 * Three things are counted, because they are what an agent spends:
 *
 * - `tokens`: the run's `usage.totalTokens`, its tools' sub-runs, `generate`
 *   calls and images included, as `result().usage` counts them;
 * - `steps`: the run's own model calls (a sub-run's are its own);
 * - `toolCalls`: the tool calls the model made in the run that were executed.
 *
 * A limit is checked before the thing it limits: before every model call
 * (`steps`, `tokens`) and before every tool call (`toolCalls`). Tokens can only
 * be counted after a call, so a run stops once it has *reached* its token
 * limit, and the call that crossed it is not undone. Under concurrency a
 * scope's limit is soft in the same way: two runs of one key can each take
 * their next step before either has added what it spent.
 */

/** A budget: each field is a maximum, and a field left out is no limit. */
export type UsageLimit = {
  tokens?: number;
  steps?: number;
  toolCalls?: number;
};

/** What was spent. */
export type UsageCounts = {
  tokens: number;
  steps: number;
  toolCalls: number;
};

/**
 * Where a scope's spending is kept across runs. `add` is called with what a
 * run spent since its last `add`, after each model call and each batch of
 * tool calls, and `get` before each check. Give a shared store (a database
 * row, a Redis hash) when more than one process runs agents; the default,
 * `MemoryUsageLimitStore`, counts per process and forgets on restart.
 *
 * A key holds forever: put the period in it (`tenant:42:2026-11`) for a
 * monthly budget, and let the store expire old keys when it can.
 */
export interface UsageLimitStore {
  get(key: string): UsageCounts | Promise<UsageCounts>;
  add(key: string, delta: UsageCounts): void | Promise<void>;
}

const zero = (): UsageCounts => ({ tokens: 0, steps: 0, toolCalls: 0 });

/** Counts per key, in this process. */
export class MemoryUsageLimitStore implements UsageLimitStore {
  private readonly counts = new Map<string, UsageCounts>();

  get(key: string): UsageCounts {
    return { ...(this.counts.get(key) ?? zero()) };
  }

  add(key: string, delta: UsageCounts): void {
    const current = this.counts.get(key) ?? zero();
    this.counts.set(key, {
      tokens: current.tokens + delta.tokens,
      steps: current.steps + delta.steps,
      toolCalls: current.toolCalls + delta.toolCalls,
    });
  }

  /** Forgets one key, or every key. */
  reset(key?: string): void {
    if (key === undefined) this.counts.clear();
    else this.counts.delete(key);
  }
}

/** The store a run uses when its limits name none. */
export const defaultUsageLimitStore = new MemoryUsageLimitStore();

/** What `onUsage` is told. */
export type UsageReport = {
  runId: string;
  threadId?: string;
  /** The agent's name. */
  agent: string;
  /** Spent since the previous report of this run. */
  delta: UsageCounts;
  /** Spent by the run so far. */
  total: UsageCounts;
  /** The scope keys the run counts against. */
  scopes: string[];
  /** `true` on the run's last report, sent once as it ends, whatever the delta. */
  final: boolean;
};

/**
 * A run's usage limits: `AgentStreamParams.usageLimits`, or what
 * `AgentController.usageLimits()` answers.
 */
export type AgentUsageLimits = {
  /** This run's own budget. */
  run?: UsageLimit;
  /** Budgets shared by every run that names the same key, kept in `store`. */
  scopes?: readonly { key: string; limit: UsageLimit }[];
  /** Where `scopes` are counted. Default `defaultUsageLimitStore`, in memory. */
  store?: UsageLimitStore;
  /**
   * Hears what the run spent: after each model call and each batch of tool
   * calls that spent something, and once more as the run ends (`final`).
   * Awaited; a throw is logged and the run goes on. A store whose `add`
   * throws is logged the same way; one whose `get` throws fails the run
   * (code `unknown`, retryable) rather than letting it go on unmetered.
   */
  onUsage?: (report: UsageReport) => void | Promise<void>;
};

/** Which limit a run reached, on `result().error.usageLimit`. */
export type UsageLimitHit = {
  /** `"run"`, or the scope's key. */
  scope: string;
  metric: keyof UsageCounts;
  limit: number;
  used: number;
};

/**
 * A scope's spending could not be read: the run fails (code `unknown`,
 * retryable) rather than going on unmetered. @internal
 */
export class UsageLimitStoreError extends Error {
  constructor(cause: unknown) {
    super("The usage limits could not be checked.", { cause });
    this.name = "UsageLimitStoreError";
  }
}

const METRICS: (keyof UsageCounts)[] = ["tokens", "steps", "toolCalls"];

const NOUNS: Record<keyof UsageCounts, string> = {
  tokens: "tokens",
  steps: "model calls",
  toolCalls: "tool calls",
};

/** The sentence a client is told: the scope's key is the server's, and is left out. */
export function usageLimitMessage(hit: UsageLimitHit): string {
  const what = `${hit.limit} ${NOUNS[hit.metric]}`;
  return hit.scope === "run"
    ? `The run reached its usage limit of ${what} and was stopped.`
    : `The usage limit of ${what} has been reached.`;
}

/** Throws at `Agent.stream` on a limit that can't be meant. */
export function assertUsageLimits(limits: AgentUsageLimits, owner: string): void {
  const check = (limit: UsageLimit, where: string) => {
    for (const metric of METRICS) {
      const value = limit[metric];
      if (value === undefined) continue;
      if (!(Number.isInteger(value) && value >= 0)) {
        throw new Error(
          `${owner} sets \`usageLimits.${where}.${metric}\` to ${String(value)}, but it has to be a whole number of at least 0.`,
        );
      }
    }
  };
  if (limits.run) check(limits.run, "run");
  for (const [i, scope] of (limits.scopes ?? []).entries()) {
    if (typeof scope.key !== "string" || scope.key === "") {
      throw new Error(`${owner} gives \`usageLimits.scopes[${i}]\` no key.`);
    }
    check(scope.limit, `scopes[${i}].limit`);
  }
}

const minus = (a: UsageCounts, b: UsageCounts): UsageCounts => ({
  tokens: a.tokens - b.tokens,
  steps: a.steps - b.steps,
  toolCalls: a.toolCalls - b.toolCalls,
});

/** One run's limits, and what it has reported so far. @internal */
export class RunUsageLimiter {
  private reported: UsageCounts = zero();
  private readonly store: UsageLimitStore;
  private readonly scopes: readonly { key: string; limit: UsageLimit }[];

  constructor(
    private readonly limits: AgentUsageLimits,
    private readonly info: { runId: string; threadId?: string; agent: string },
    private readonly onHookError: (error: unknown) => void,
  ) {
    this.store = limits.store ?? defaultUsageLimitStore;
    this.scopes = limits.scopes ?? [];
  }

  /**
   * The first limit that `adding` would take past its maximum, given what the
   * run has spent (`current`): `null` when there is none. A scope's spending is
   * what its store holds plus what this run spent since it last added.
   */
  async check(current: UsageCounts, adding: Partial<UsageCounts>): Promise<UsageLimitHit | null> {
    const over = (scope: string, limit: UsageLimit, used: UsageCounts): UsageLimitHit | null => {
      for (const metric of METRICS) {
        const max = limit[metric];
        const more = adding[metric] ?? 0;
        if (max === undefined || more === 0) continue;
        if (used[metric] + more > max) return { scope, metric, limit: max, used: used[metric] };
      }
      return null;
    };
    if (this.limits.run) {
      const hit = over("run", this.limits.run, current);
      if (hit) return hit;
    }
    if (this.scopes.length === 0) return null;
    const pending = minus(current, this.reported);
    for (const scope of this.scopes) {
      let stored: UsageCounts;
      try {
        stored = await this.store.get(scope.key);
      } catch (error) {
        throw new UsageLimitStoreError(error);
      }
      const used = {
        tokens: stored.tokens + pending.tokens,
        steps: stored.steps + pending.steps,
        toolCalls: stored.toolCalls + pending.toolCalls,
      };
      const hit = over(scope.key, scope.limit, used);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Adds what was spent since the last call to every scope's store, and tells
   * `onUsage`. Skipped when nothing was spent, unless `final`.
   */
  async report(current: UsageCounts, final = false): Promise<void> {
    const delta = minus(current, this.reported);
    const spent = delta.tokens !== 0 || delta.steps !== 0 || delta.toolCalls !== 0;
    if (!spent && !final) return;
    this.reported = { ...current };
    if (spent) {
      for (const scope of this.scopes) {
        try {
          await this.store.add(scope.key, delta);
        } catch (error) {
          // Logged, not thrown: the work is done and billed by the provider
          // either way, and failing the run now would not take it back.
          this.onHookError(error);
        }
      }
    }
    if (!this.limits.onUsage) return;
    try {
      await this.limits.onUsage({
        ...this.info,
        delta,
        total: { ...current },
        scopes: this.scopes.map((scope) => scope.key),
        final,
      });
    } catch (error) {
      this.onHookError(error);
    }
  }
}
