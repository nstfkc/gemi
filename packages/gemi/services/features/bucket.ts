/**
 * Deterministic bucketing for percentage rollouts and weighted variants.
 *
 * ## Why SHA-1 and not `Bun.hash`
 *
 * `Bun.hash` is faster and wrong for this. Its output is seeded and is not a
 * documented stable contract across Bun versions, so a runtime upgrade could
 * silently re-bucket every user in the middle of a rollout — the 10% who had the
 * new checkout become a different 10%, and nobody finds out from a stack trace.
 * SHA-1 is a fixed standard: the same string maps to the same bucket on every
 * machine, every process and every version, forever. This is a correctness
 * requirement, not a security one, so SHA-1's collision weakness is irrelevant
 * here — and `Bun.CryptoHasher("sha1")` is already how `server/generateEtag.ts`
 * hashes.
 *
 * ## What is in the key, and why each part
 *
 * `namespace:flagKey:seed:ruleId:subject`
 *
 * - `namespace` separates the rollout gate from the variant split. Without it a
 *   subject that scraped into a 10% rollout would land at the same position in
 *   the variant range every time, systematically pushing early-rollout users
 *   into the first variant.
 * - `flagKey` and `seed` decorrelate flags. Two independent 50% rollouts must
 *   not select the same half; `seed` is a per-row `cuid()`, so they do not.
 *   Changing it is also the deliberate way to re-randomise one flag.
 * - `ruleId` decorrelates two rollouts inside one flag.
 * - `subject` is the user, from `bucketBy`.
 */
const RESOLUTION = 10_000;

/** The bucket key. Exported so a test can pin exact strings to exact buckets. */
export function bucketKey(
  namespace: "rollout" | "variant",
  flagKey: string,
  seed: string,
  ruleId: string,
  subject: string,
): string {
  return `${namespace}:${flagKey}:${seed}:${ruleId}:${subject}`;
}

/**
 * A stable integer in `[0, RESOLUTION)` — i.e. 0.01% granularity.
 *
 * Takes the first 32 bits of the digest. That is four orders of magnitude more
 * entropy than the 10,000 buckets it is reduced to, so the modulo bias is far
 * below the noise floor of any rollout anyone would configure.
 */
export function bucketOf(key: string): number {
  const digest = new Bun.CryptoHasher("sha1").update(key).digest("hex");
  const n = Number.parseInt(digest.slice(0, 8), 16);
  return Math.floor((n / 0x1_00000000) * RESOLUTION);
}

/**
 * Whether `bucket` falls inside `percent`.
 *
 * `bucket < threshold` rather than a range test, which buys monotonicity for
 * free: a subject inside a 10% rollout is still inside the same rule's 20%
 * rollout. Ramping a rollout up therefore only ever *adds* people. The
 * alternative — anything that reshuffles on each change — means a user who saw
 * the new feature at 10% can lose it at 20%, which reads as a bug to them and
 * invalidates any measurement taken across the change.
 */
export function inRollout(bucket: number, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return bucket < Math.round(percent * (RESOLUTION / 100));
}

/**
 * Picks a weighted variant.
 *
 * Weights are relative and normalised, so `[1, 1]` and `[50, 50]` agree. The
 * final variant absorbs the rounding drift, which is why the loop returns it
 * unconditionally at the end rather than falling through to an error: floor()ing
 * each cumulative boundary leaves up to `n-1` buckets unassigned, and they have
 * to belong to somebody.
 *
 * Returns `null` when the weights cannot describe a distribution at all (empty,
 * or summing to zero or less) — the caller reports that as `reason: "error"`
 * rather than inventing a value.
 */
export function pickVariant<T>(
  variants: readonly { value: T; weight: number }[],
  bucket: number,
): T | null {
  if (variants.length === 0) return null;

  let total = 0;
  for (const variant of variants) {
    // A negative weight would subtract from the cumulative cursor and make the
    // boundaries non-monotonic, so it is not merely ignored — it is refused.
    if (!Number.isFinite(variant.weight) || variant.weight < 0) return null;
    total += variant.weight;
  }
  if (total <= 0) return null;

  let cursor = 0;
  for (const variant of variants) {
    cursor += Math.floor((variant.weight / total) * RESOLUTION);
    if (bucket < cursor) return variant.value;
  }
  return variants[variants.length - 1].value;
}

export { RESOLUTION };
