// @ts-ignore - `sharp` is a peer dependency; only its types are wanted here.
import type sharpNamespace from "sharp";

/**
 * `sharp`, imported on first use rather than at module load.
 *
 * Three modules need it — the `Sharp` optimization driver, the `Storage` facade
 * and the OG-image branch of `ViewRouteDispatcher` — and all three are reachable
 * from the `gemi/services` and `gemi/facades` barrels, which are also the only
 * door an application has to `CronJob`, `Job`, `DB` and `Lang`. A static import
 * made every one of those imports load a native binary (#403).
 *
 * `sharp` is the only one of the four that can be genuinely absent — it is a
 * peer dependency, so an install can skip its platform binary — which is why
 * the failure gets a message naming the caller rather than a bare resolution
 * error. `usedBy` is that name, written as the caller reads in a stack trace.
 *
 * No memo: the module registry already caches a resolved `import()`, and
 * caching the *failure* would make every later call report the first call's
 * stack instead of its own.
 */
export async function loadSharp(usedBy: string): Promise<typeof sharpNamespace> {
  try {
    // @ts-ignore - peer dependency, resolved out of the application's own tree
    return (await import("sharp")).default;
  } catch (error) {
    throw new Error(
      `${usedBy} requires the 'sharp' package. Install it with \`bun add sharp\`.`,
      { cause: error },
    );
  }
}
