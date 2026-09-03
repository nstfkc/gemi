import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Semver comparison and the project's installed gemi version.
 *
 * Shared by `gemi dev`'s update notice and `gemi upgrade`, which have to agree:
 * a notice that says an upgrade is available and an `upgrade` that then reports
 * "already up to date" is worse than neither, so both read the installed
 * version through `readInstalledVersion` and order releases through
 * `compareVersions` rather than each rolling its own.
 *
 * No `semver` dependency — gemi has none, and adding one to compare two strings
 * would be the only runtime dependency the CLI needs at startup. The subset
 * implemented here is precedence (spec §11), which is all either caller asks
 * for; range matching is deliberately absent because nothing here resolves a
 * range.
 */

export interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

// `1.2.3`, `1.2.3-rc.1`, `1.2.3-rc.1+build`. Build metadata is captured so it can
// be discarded: it is explicitly *not* part of precedence, so `1.0.0+a` and
// `1.0.0+b` have to compare equal rather than by string.
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_RE.exec(version.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

const NUMERIC_RE = /^\d+$/;

// Semver §11.4.4: numeric identifiers compare numerically, alphanumerics
// compare in ASCII order, and a numeric identifier always sorts *below* an
// alphanumeric one. `rc.2` vs `rc.10` is the case that makes this worth writing
// out — string comparison puts `rc.10` first and would hide a released upgrade.
function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC_RE.test(a);
  const bNumeric = NUMERIC_RE.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence: negative if `a` sorts before `b`, positive if after, 0 if
 * equal. Unparseable input sorts as equal to everything, so a version string
 * neither side understands can never be reported as an upgrade.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (let i = 0; i < 3; i++) {
    const diff = left.core[i]! - right.core[i]!;
    if (diff !== 0) return diff;
  }

  // A prerelease sorts below the release it leads to: 0.60.0-rc.1 < 0.60.0.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const diff = comparePrereleaseIdentifiers(left.prerelease[i]!, right.prerelease[i]!);
    if (diff !== 0) return diff;
  }
  return left.prerelease.length - right.prerelease.length;
}

/**
 * The dist-tag a version belongs to. gemi publishes release candidates under
 * the `rc` tag (a GitHub Release would put them on `latest`), so an app running
 * `0.60.0-rc.2` has to be compared against `rc` — compared against `latest` it
 * would be told to "upgrade" to the older stable release it deliberately went
 * ahead of.
 */
export function channelFor(version: string): string {
  const parsed = parseVersion(version);
  const first = parsed?.prerelease[0];
  // `0.60.0-1` is a prerelease with a numeric identifier and no channel name;
  // there is no dist-tag to infer from it, so fall back to `latest`.
  return first && !NUMERIC_RE.test(first) ? first : "latest";
}

/**
 * The installed gemi package directory — the nearest `node_modules/gemi` at or
 * above `rootDir`, or `null` outside a gemi project.
 *
 * Found off disk rather than through `Bun.resolveSync("gemi/package.json")`:
 * gemi's `exports` map does not name `./package.json`, so that resolution works
 * only because Bun is lenient about it today. Walking up is also what makes a
 * hoisted install work, which is most of them.
 *
 * `gemi install-skill` reads the shipped skill out of this directory, and
 * `readInstalledVersion` reads the manifest in it, so they cannot disagree about
 * which copy of gemi the project is running.
 */
export function findGemiPackageDir(rootDir: string): string | null {
  let dir = path.resolve(rootDir);
  while (true) {
    const candidate = path.join(dir, "node_modules", "gemi");
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The version of gemi the project has installed. `null` when there is no
 * installed copy — the caller is running outside a gemi project, and the callers
 * treat that as "nothing to say" rather than an error.
 */
export function readInstalledVersion(rootDir: string): string | null {
  const packageDir = findGemiPackageDir(rootDir);
  if (!packageDir) return null;
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    return typeof manifest?.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
