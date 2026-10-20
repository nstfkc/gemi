import { AsyncLocalStorage } from "node:async_hooks";
import { addUsage, emptyUsage } from "./runtime";
import type { Usage } from "./types";

/**
 * Usage metering by async context (#1005).
 *
 * An eval, or a bill, wants to know what a piece of work cost in tokens, and
 * the model calls it made are often deep in app code: a tool that runs a
 * builder that calls `generate`, a compaction summary, an image. Threading a
 * counter through all of that is the plumbing every caller would forget, so
 * the calls report themselves instead: each model call's `finish` frame (an
 * agent step, `generate`, an image generation or edit) is recorded on every
 * meter open in the async context it ran in.
 *
 * Recorded per provider call, never per run: a run's `usage` already includes
 * its sub-runs and its tools' `generate` calls, so metering runs would count
 * those twice.
 */
type Meter = { usage: Usage; byModel: Map<string, Usage>; open: boolean };

const meters = new AsyncLocalStorage<readonly Meter[]>();

/** What `measureUsage` measured. */
export type MeasuredUsage<T> = {
  value: T;
  /** Every model call made inside `fn`, summed. */
  usage: Usage;
  /** The same, by the model the provider reported (or was asked for). */
  byModel: Record<string, Usage>;
};

/**
 * Runs `fn` and sums the usage of every model call made inside it, however
 * deep: an `Agent` step, `generate()`, an `ImageModel` call. Meters nest: an
 * inner one's calls also count for the outer one.
 *
 *     const { value, usage, byModel } = await measureUsage(() => agent.stream(params).result());
 *
 * Work `fn` started and did not wait for (a background summary, say) counts
 * only if it finishes before `fn` does.
 */
export async function measureUsage<T>(fn: () => T | Promise<T>): Promise<MeasuredUsage<T>> {
  const meter: Meter = { usage: emptyUsage(), byModel: new Map(), open: true };
  const stack = [...(meters.getStore() ?? []), meter];
  try {
    const value = await meters.run(stack, fn);
    return { value, usage: meter.usage, byModel: Object.fromEntries(meter.byModel) };
  } finally {
    meter.open = false;
  }
}

/** Called by the model call sites with each `finish` frame's usage. */
export function recordUsage(model: string, usage: Usage | undefined): void {
  if (!usage) return;
  const stack = meters.getStore();
  if (!stack) return;
  for (const meter of stack) {
    if (!meter.open) continue;
    meter.usage = addUsage(meter.usage, usage);
    meter.byModel.set(model, addUsage(meter.byModel.get(model) ?? emptyUsage(), usage));
  }
}
