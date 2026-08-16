/**
 * Deterministic bucketing for percentage rollouts.
 *
 * ## Why nothing is stored
 *
 * A subject's bucket is a pure function of the feature and the subject, so it is
 * the same on every machine, in every process, on every device that subject logs
 * in from, forever — without a row, a cookie, or a cache holding the assignment.
 * Persisting assignments would be strictly worse: it would be per-browser rather
 * than per-subject, it would need migrating whenever a feature changes, and it
 * would grow with the user count.
 *
 * ## Why SHA-1 and not `Bun.hash`
 *
 * `Bun.hash` is faster and wrong for this. Its output is seeded and is not a
 * documented stable contract across Bun versions, so a runtime upgrade could
 * silently re-bucket every subject in the middle of a rollout — the 10% who had
 * the new checkout become a different 10%, and nobody finds out from a stack
 * trace. SHA-1 is a fixed standard: the same string maps to the same bucket on
 * every machine, every process and every version. This is a correctness
 * requirement, not a security one, so SHA-1's collision weakness is irrelevant
 * here — and `Bun.CryptoHasher("sha1")` is already how `server/generateEtag.ts`
 * hashes.
 *
 * ## What is in the key
 *
 * `salt:subject`, where `salt` defaults to the feature's key.
 *
 * The salt is what decorrelates features from each other. Without it two
 * independent 20% rollouts would select the *same* 20% of subjects, so a user
 * unlucky once would be unlucky in everything and the two populations could
 * never be reasoned about separately.
 */
const RESOLUTION = 10_000;

/** The bucket key. Exported so a test can pin exact strings to exact buckets. */
export function bucketKey(salt: string, subject: string): string {
  return `${salt}:${subject}`;
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
 * free: a subject inside a 10% rollout is still inside the same feature's 20%
 * rollout. Ramping up therefore only ever *adds* people. The alternative —
 * anything that reshuffles on each change — means a user who saw the feature at
 * 10% can lose it at 20%, which reads as a bug to them and invalidates any
 * measurement taken across the change.
 */
export function inRollout(bucket: number, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return bucket < Math.round(percent * (RESOLUTION / 100));
}

export { RESOLUTION };
