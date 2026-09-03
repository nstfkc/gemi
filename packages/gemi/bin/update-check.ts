import { fetchPublishedVersion } from "./registry";
import { channelFor, compareVersions, parseVersion, readInstalledVersion } from "./version";

/**
 * The "a newer gemi is out" notice `gemi dev` prints.
 *
 * Advisory in the strongest sense: it runs beside the dev server rather than
 * before it, every failure path is silence, and nothing it does can keep the
 * CLI process alive. A version check is not worth one second of a dev server's
 * startup, and it is certainly not worth a dev server that will not start on a
 * train.
 */

export interface UpdateCheckOptions {
  rootDir: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Whether to check at all. Skipped when the user opted out, and in CI — where
 * nobody reads the message, the network call is pure latency, and a build log
 * that changes when an unrelated package publishes is noise.
 */
export function shouldCheckForUpdate(env: Record<string, string | undefined>): boolean {
  if (env.GEMI_NO_UPDATE_CHECK) return false;
  if (env.CI) return false;
  return true;
}

/**
 * The message, given two versions. Separate from the fetch so the wording is
 * testable without a network, and so `upgrade` and `dev` cannot drift on which
 * comparison counts as "newer".
 *
 * `null` when there is nothing to say: same version, a local build ahead of the
 * registry (a linked checkout, which is every contributor), or a version string
 * that would not parse.
 */
export function formatUpdateNotice(installed: string, published: string): string | null {
  if (compareVersions(published, installed) <= 0) return null;

  const from = parseVersion(installed);
  const to = parseVersion(published);
  // Pre-1.0, the minor is the breaking position — 0.55 → 0.56 required deleting
  // `gemi.d.ts` to keep typechecking — so a minor bump earns the pointer to
  // UPGRADE.md and a patch does not.
  const breaking = !!from && !!to && (from.core[0] !== to.core[0] || from.core[1] !== to.core[1]);

  return [
    `\n  Update available: gemi ${installed} → ${published}`,
    `  Run \`gemi upgrade\` to update.`,
    ...(breaking
      ? [
          `  This crosses a minor version — read UPGRADE.md before you do:`,
          `  https://github.com/nstfkc/gemi/blob/main/UPGRADE.md`,
        ]
      : []),
    "",
  ].join("\n");
}

/**
 * Resolve the notice for the project at `rootDir`, or `null` if there is none.
 * Does not print — `dev` decides when, so the message lands after the server
 * has said what it is doing rather than in front of it.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | null> {
  const { rootDir, env = process.env, timeoutMs, fetchImpl } = options;
  if (!shouldCheckForUpdate(env)) return null;

  const installed = readInstalledVersion(rootDir);
  if (!installed) return null;

  const published = await fetchPublishedVersion(channelFor(installed), {
    timeoutMs,
    fetchImpl,
  });
  if (!published) return null;

  return formatUpdateNotice(installed, published);
}

/**
 * Fire-and-forget wrapper for `dev`. Returns nothing and rejects for nothing:
 * an unhandled rejection here would take down a dev server over a failed HEAD
 * request to npm.
 */
export function reportUpdate(
  options: UpdateCheckOptions,
  log: (message: string) => void = console.log,
): Promise<void> {
  return checkForUpdate(options)
    .then((notice) => {
      if (notice) log(notice);
    })
    .catch(() => {});
}
