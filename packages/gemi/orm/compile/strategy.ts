import type { SqlDialect } from "../dialect";
import { UnsupportedQueryError } from "../errors";
import { lateralStrategy } from "./lateral";
import { batchedStrategy, type RelationStrategy } from "./plan-relations";

/**
 * Choosing a relation strategy.
 *
 * Its own module, and not for tidiness: `lateral.ts` imports `plan-relations.ts`
 * for the batched plan it falls back to, so anything naming both has to sit above
 * them or the import graph is a cycle. That is also the honest layering — the
 * strategies do not know about each other, and selection is the only thing that
 * knows about both.
 */

/**
 * **Lateral on Postgres, batched everywhere else.**
 *
 * The rule is the dialect and nothing more, which is as simple as the plan asked
 * for — and it is sufficient because the *strategy* declines per node for
 * everything it cannot fold. Selection does not need to know about tree depth or
 * row counts; it needs to know whether folding is possible at all, and that is a
 * property of the dialect.
 *
 * **What justifies Postgres defaulting to lateral**, since this changes what every
 * existing include does there:
 *
 * - It removes a round trip per include node, and on Postgres a round trip is the
 *   dominant cost of a small query. The counts are in `plans/orm/benchmarks.md`,
 *   measured rather than argued: 1, 2 and 3 statements for no-include, depth-2 and
 *   depth-3.
 * - The **full** nested differential matrix runs against it — every relation case
 *   in `differential.test.ts`, derived from the same table the batched run uses so
 *   the two cannot drift — and matches Prisma. That is iteration 9's acceptance
 *   criterion 2, and it is what this line was waiting for.
 * - Anything it cannot express falls back per node, so a tree it only half
 *   understands is still correct.
 *
 * SQLite keeps batching: its round trips are in-process and cost tens of
 * microseconds, so `json_group_array` would be complexity bought with nothing. The
 * plan says build it only if a measurement asks, and none does.
 *
 * A caller can override either way with `ExecOptions.strategy`.
 */
export function defaultStrategy(dialect: SqlDialect): RelationStrategy {
  return dialect.name === "postgres" ? lateralStrategy : batchedStrategy;
}

/**
 * The named strategy, or the dialect's default.
 *
 * An unknown name raises rather than falling back: a typo that silently ran the
 * other strategy would be a performance mystery with no error attached, and the
 * set is two.
 */
export function resolveStrategy(
  named: string | undefined,
  dialect: SqlDialect,
  // Required, so the caller cannot fall back to a placeholder without saying
  // so. This used to report `"Model"` and `"$exec"` — a base class and
  // something that is not one of the operations — while `$exec`, its
  // only caller, had both in scope (#112).
  origin: { model: string; operation: string },
): RelationStrategy {
  if (named === undefined) return defaultStrategy(dialect);
  if (named === "batched") return batchedStrategy;
  if (named === "lateral") return lateralStrategy;

  throw new UnsupportedQueryError(
    `strategy: ${JSON.stringify(named)}`,
    origin.model,
    origin.operation,
    `Unknown relation strategy. Expected "batched" or "lateral".`,
  );
}
