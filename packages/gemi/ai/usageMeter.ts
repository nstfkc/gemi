import { AsyncLocalStorage } from "node:async_hooks";
import { addUsage, emptyUsage } from "./runtime";
import type { Usage as UsageType } from "./types";

/**
 * Usage metering by async context (#1005), with costs (#1021).
 *
 * An eval, or a bill, wants to know what a piece of work cost, and the model
 * calls it made are often deep in app code: a tool that runs a builder that
 * calls `generate`, a compaction summary, an image. Threading a counter
 * through all of that is the plumbing every caller would forget, so the calls
 * report themselves instead: each model call's `finish` frame (an agent step,
 * `generate`, an image generation or edit) is recorded on every meter open in
 * the async context it ran in.
 *
 * Recorded per provider call, never per run: a run's `usage` already includes
 * its sub-runs and its tools' `generate` calls, so metering runs would count
 * those twice. That is also why a run's cost has to be metered rather than
 * worked out from `result.usage` afterwards: that sum mixes models, and each
 * call is priced here, when it is recorded, at its own model's prices.
 */

/** USD per million tokens. `cachedInput` defaults to `input`. */
export type ModelPrice = {
  input: number;
  output: number;
  cachedInput?: number;
  /** For image tokens (`Usage.imageInputTokens` / `imageOutputTokens`);
   *  they're priced as text when these are absent. */
  imageInput?: number;
  imageOutput?: number;
};

/**
 * What a model call costs.
 *
 * A table: USD per million tokens by model id, where a key also prices the ids
 * it is a prefix of (`gpt-5.4` prices `gpt-5.4-2026-03-05`) and the longest
 * key wins. Or a function, answering the cost in whatever unit the app counts
 * in (USD micros, credits), and `undefined` for a model it doesn't price.
 *
 * Every cost a meter holds is in this unit, `add`ed ones included, so an app
 * that prices with a function in micros adds micros.
 */
export type UsagePricing =
  | Record<string, ModelPrice>
  | ((model: string, usage: UsageType) => number | undefined);

/** One row of `UsageTotals.byModel` or `byLabel`. */
export type UsageLine = {
  /** Tokens. Zero for a label that only had costs `add`ed. */
  usage: UsageType;
  cost: number;
  /** Model calls, plus `add`s for a label. */
  count: number;
};

/** What a meter has counted so far. */
export type UsageTotals = {
  /** Every model call, summed. */
  usage: UsageType;
  /** The priced model calls and every `add`ed cost. */
  cost: number;
  /** By the model the provider reported (or was asked for). */
  byModel: Record<string, UsageLine>;
  /**
   * By label: what was `add`ed under it, and the model calls made inside a
   * meter opened with that `label` (the innermost label wins). Calls outside
   * any labelled meter are in the totals and `byModel`, not here.
   */
  byLabel: Record<string, UsageLine>;
  /** Models called that the pricing doesn't price; their calls cost 0. */
  unpriced: string[];
};

/** An open meter: what `Usage.meter` hands its function, and `ctx.meter`. */
export interface UsageMeter {
  readonly label: string | undefined;
  /**
   * Adds a cost that isn't a model call gemi made (a browser session, an
   * external API) under `label`, to this meter and every meter around it.
   * In the pricing's unit. A no-op once the meter's scope has settled.
   */
  add(label: string, cost: number): void;
  /** What it has counted so far. A copy. */
  totals(): UsageTotals;
}

/** What `Usage.meter` measured: the function's value and the totals. */
export type MeteredUsage<T> = UsageTotals & { value: T };

export type UsageMeterOptions = {
  /** Attributes every call inside to this label, here and in enclosing meters. */
  label?: string;
  /** Overrides the enclosing meter's pricing, or `Usage.configure`'s, for this one. */
  pricing?: UsagePricing;
};

class Meter implements UsageMeter {
  readonly label: string | undefined;
  open = true;
  /** The meters around this one, outermost first, and this one last. */
  readonly stack: readonly Meter[];
  private readonly pricing: UsagePricing | undefined;
  private usage: UsageType = emptyUsage();
  private cost = 0;
  private readonly byModel = new Map<string, UsageLine>();
  private readonly byLabel = new Map<string, UsageLine>();
  private readonly unpriced = new Set<string>();

  constructor(parents: readonly Meter[], options: UsageMeterOptions) {
    this.label = options.label;
    this.pricing = options.pricing;
    this.stack = [...parents, this];
  }

  /** Its own pricing, else the nearest enclosing meter's, else the configured one. */
  private resolvePricing(): UsagePricing | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const pricing = this.stack[i]!.pricing;
      if (pricing) return pricing;
    }
    return configured;
  }

  recordCall(model: string, usage: UsageType, label: string | undefined) {
    if (!this.open) return;
    const cost = priceUsage(this.resolvePricing(), model, usage);
    if (cost === undefined) this.unpriced.add(model);
    this.usage = addUsage(this.usage, usage);
    this.cost += cost ?? 0;
    bump(this.byModel, model, usage, cost ?? 0);
    if (label !== undefined) bump(this.byLabel, label, usage, cost ?? 0);
  }

  recordCost(label: string, cost: number) {
    if (!this.open) return;
    this.cost += cost;
    bump(this.byLabel, label, undefined, cost);
  }

  add(label: string, cost: number): void {
    if (!this.open) return;
    for (const meter of this.stack) meter.recordCost(label, cost);
  }

  totals(): UsageTotals {
    return {
      usage: { ...this.usage },
      cost: this.cost,
      byModel: copyLines(this.byModel),
      byLabel: copyLines(this.byLabel),
      unpriced: [...this.unpriced],
    };
  }
}

function bump(
  lines: Map<string, UsageLine>,
  key: string,
  usage: UsageType | undefined,
  cost: number,
) {
  const line = lines.get(key) ?? { usage: emptyUsage(), cost: 0, count: 0 };
  lines.set(key, {
    usage: usage ? addUsage(line.usage, usage) : line.usage,
    cost: line.cost + cost,
    count: line.count + 1,
  });
}

function copyLines(lines: Map<string, UsageLine>): Record<string, UsageLine> {
  return Object.fromEntries(
    [...lines].map(([key, line]) => [key, { ...line, usage: { ...line.usage } }]),
  );
}

const meters = new AsyncLocalStorage<readonly Meter[]>();
let configured: UsagePricing | undefined;

/** The open meters of the current async context, innermost last. */
function openStack(): readonly Meter[] {
  return (meters.getStore() ?? []).filter((meter) => meter.open);
}

/**
 * Opens a meter nested in whatever meters are open here, without running
 * anything yet: an agent run opens its own with this, runs its loop in it
 * (`run`) and closes it when the loop settles. `Usage.meter` is the outside.
 */
export function openMeter(options: UsageMeterOptions = {}): {
  meter: UsageMeter;
  run: <T>(fn: () => T) => T;
  close: () => void;
} {
  const meter = new Meter(meters.getStore() ?? [], options);
  return {
    meter,
    run: (fn) => meters.run(meter.stack, fn),
    close: () => {
      meter.open = false;
    },
  };
}

async function meter<T>(
  fn: (meter: UsageMeter) => T | Promise<T>,
  options: UsageMeterOptions = {},
): Promise<MeteredUsage<T>> {
  const scope = openMeter(options);
  try {
    const value = await scope.run(() => fn(scope.meter));
    return { ...scope.meter.totals(), value };
  } finally {
    scope.close();
  }
}

/** Called by the model call sites with each `finish` frame's usage. */
export function recordUsage(model: string, usage: UsageType | undefined): void {
  if (!usage) return;
  const stack = openStack();
  if (stack.length === 0) return;
  let label: string | undefined;
  for (const meter of stack) label = meter.label ?? label;
  for (const meter of stack) meter.recordCall(model, usage, label);
}

function priceFor(pricing: Record<string, ModelPrice>, model: string): ModelPrice | undefined {
  if (pricing[model]) return pricing[model];
  const key = Object.keys(pricing)
    .filter((name) => model.startsWith(name))
    .sort((a, b) => b.length - a.length)[0];
  return key ? pricing[key] : undefined;
}

/** One model call's cost under `pricing`; `undefined` when it isn't priced. */
export function priceUsage(
  pricing: UsagePricing | undefined,
  model: string,
  usage: UsageType,
): number | undefined {
  if (!pricing) return undefined;
  if (typeof pricing === "function") return pricing(model, usage);
  const price = priceFor(pricing, model);
  if (!price) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const imageIn = usage.imageInputTokens ?? 0;
  const imageOut = usage.imageOutputTokens ?? 0;
  return (
    ((usage.inputTokens - cached - imageIn) * price.input +
      cached * (price.cachedInput ?? price.input) +
      imageIn * (price.imageInput ?? price.input) +
      (usage.outputTokens - imageOut) * price.output +
      imageOut * (price.imageOutput ?? price.output)) /
    1_000_000
  );
}

/** What `measureUsage` measured. */
export type MeasuredUsage<T> = {
  value: T;
  /** Every model call made inside `fn`, summed. */
  usage: UsageType;
  /** The same, by the model the provider reported (or was asked for). */
  byModel: Record<string, UsageType>;
};

/**
 * Runs `fn` and sums the usage of every model call made inside it, however
 * deep: an `Agent` step, `generate()`, an `ImageModel` call. Meters nest: an
 * inner one's calls also count for the outer one.
 *
 *     const { value, usage, byModel } = await measureUsage(() => agent.stream(params).result());
 *
 * Work `fn` started and did not wait for (a background summary, say) counts
 * only if it finishes before `fn` does. `Usage.meter` is the same with costs.
 */
export async function measureUsage<T>(fn: () => T | Promise<T>): Promise<MeasuredUsage<T>> {
  const { value, usage, byModel } = await meter(() => fn());
  return {
    value,
    usage,
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([model, line]) => [model, line.usage]),
    ),
  };
}

/**
 * Token usage, and (as a value) the meter that adds it up with costs.
 *
 *     Usage.configure({ pricing: { "gpt-5.4": { input: 1.25, output: 10 } } });
 *     const { value, cost, byModel, byLabel } = await Usage.meter(async (meter) => {
 *       await review(page);           // every model call inside, however deep
 *       meter.add("browser", 0.002);  // a cost that isn't a model call
 *       return "done";
 *     });
 */
export type Usage = UsageType;

export const Usage = {
  /**
   * The pricing every meter uses unless it, or a meter around it, has its
   * own. Read when a call is recorded, so meters already open pick it up.
   * `{ pricing: undefined }` clears it.
   */
  configure(options: { pricing?: UsagePricing }): void {
    configured = options.pricing;
  },
  /**
   * Runs `fn` with a meter open and answers its value with the totals: every
   * model call made inside it (agent steps, `generate`, images, sub-runs),
   * each priced at its own model's prices, and every cost `add`ed. Meters
   * nest: an inner one's calls and costs also count for the outer ones, and
   * concurrent meters don't see each other's. Work `fn` started and did not
   * wait for counts only if it finishes before `fn` does.
   */
  meter,
  /**
   * Adds a cost to every meter open here (the innermost one and those around
   * it), under `label`. A no-op outside any meter.
   */
  add(label: string, cost: number): void {
    openStack().at(-1)?.add(label, cost);
  },
  /**
   * Records a model call gemi didn't make itself (a vendor SDK called
   * directly, a usage report from elsewhere) on every meter open here, priced
   * like any other. A no-op outside any meter.
   */
  record(model: string, usage: UsageType): void {
    recordUsage(model, usage);
  },
  /** The innermost meter open here (a tool's is its run's), or `undefined`. */
  current(): UsageMeter | undefined {
    return openStack().at(-1);
  },
};
