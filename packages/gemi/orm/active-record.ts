import { Model } from "./Model";
import type { QueryPlan } from "./plan";

/**
 * Every query returns instances, achieved **purely** by overriding `$shape`.
 *
 * This is iteration 8's deliverable 4, and its job is to prove invariant 3 was
 * worth holding: `$shape` is a static on the model base rather than a
 * module-level function, so a subclass can change what a query *returns* without
 * any operation knowing. If that had required touching an
 * operation, it would have been a design defect to fix while the cost was still
 * small.
 *
 * It did not. The whole tier is the method below.
 *
 *     class Post extends ActiveRecordModel {
 *       static $schema = schema.Post
 *       get excerpt() { return this.body.slice(0, 100) }
 *     }
 *
 *     const posts = await Post.findMany({})   // Post instances
 *     posts[0].excerpt
 *     await posts[0].save()
 *
 * **Shipped as a documented example, not a supported tier.** Two reasons, and
 * neither is effort:
 *
 * 1. It reintroduces the conflict `wrap` exists to avoid. Queries hydrate
 *    unconditionally here, so `select: { id: true }` produces an instance whose
 *    methods can read fields the query never fetched — a runtime crash the type
 *    system cannot see, because the operations' return types still describe
 *    plain narrowed payloads. `wrap` requires a complete row precisely so that
 *    cannot happen; this trades that guarantee for ergonomics.
 * 2. The return *types* do not change. `findMany` is still typed as returning
 *    `Prisma.PostGetPayload<T>[]`, so the instance methods are invisible to
 *    TypeScript at the call site even though they are there at runtime. Fixing
 *    that means conditional return types across every operation, which is
 *    exactly the complexity the POJO baseline was chosen to avoid.
 *
 * So this file is evidence that the seam works, and a warning about what using
 * it costs. If the tier is ever pursued properly it needs its own plan — see the
 * out-of-scope section of `plans/orm/08-eloquent-doorway.md`, which is explicit
 * that half an identity map is worse than none.
 */
export abstract class ActiveRecordModel extends Model {
  /**
   * The one override. `plan.shape` still does all the work — decoding, key
   * mapping, relation placeholders — and this only decides what the resulting
   * data is *carried in*.
   *
   * Note what is not here: no per-operation branching, no knowledge of which of
   * the operations is running, and no second code path for writes. A
   * `count` returns a number and an `updateMany` returns `{ count }`; both fall
   * through untouched because they are not rows.
   */
  static override $shape(plan: QueryPlan, rows: unknown[]): unknown {
    const shaped = plan.shape(rows);

    if (Array.isArray(shaped)) {
      return shaped.map((row) => this.hydrate(row));
    }

    // A single-row operation shapes to `null` when nothing matched, and a
    // counting one to `{ count }`. Neither is a row, and hydrating either would
    // be the kind of special case this override exists to show is unnecessary.
    if (shaped === null || typeof shaped !== "object") return shaped;
    if ("count" in (shaped as object)) return shaped;

    return this.hydrate(shaped);
  }

  /**
   * Builds one instance. Separate so a subclass can decide what hydration means
   * — a value object per column, a lazily-decoded field — without reimplementing
   * the shape dispatch above.
   *
   * Goes through `Model.wrap`, so an instance from a query is tracked exactly as
   * one from `wrap` is and `save()` works on it. That reuse is the point: there
   * is one definition of "a row became an instance".
   */
  protected static hydrate(row: unknown): unknown {
    if (row === null || typeof row !== "object") return row;
    return (this as unknown as typeof Model).wrap(row as object);
  }
}
