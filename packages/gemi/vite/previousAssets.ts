import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Carrying the previous release's client assets into the new build (#548).
 *
 * A page rendered by release N asks for N's chunks for as long as the tab is
 * open. Once release N+1 is deployed, the server it reaches has only N+1's
 * `dist/client`, so N's next lazy `import()` misses and the page breaks. The
 * filenames are content-hashed and never reused for different content, so N's
 * files can sit beside N+1's under the same `/assets/` without either release
 * seeing the other's.
 *
 * So `gemi build` copies them in: before the client build it reads the
 * previous `dist/client` (the app's own, for an in-place build, or a directory
 * the deploy provides — e.g. the previous image's, see the docs), and after it
 * puts every file the new build did not write back under `dist/client/assets`.
 * What came from where is recorded in `dist/client/.vite/previous-assets.json`,
 * so the next build knows which files were the outgoing release's own and
 * which it was itself only carrying, and drops a release once it is older than
 * the grace period or more than `releases` back.
 *
 * Nothing changes at runtime: `gemi start` serves `/assets/*` from
 * `dist/client` as before, and a retained file is just a file there.
 */

export interface PreviousAssetsConfig {
  /**
   * The `dist/client` of the release being replaced. Defaults to this app's
   * own `dist/client`, which is right when the build runs where the previous
   * one did. A container build has no previous `dist/` and must point this at
   * one — see `GEMI_PREVIOUS_ASSETS`. A directory that does not exist is
   * skipped with a notice, so the first deploy needs no special case.
   */
  from?: string;
  /** How many earlier releases to keep the assets of. Default 2. */
  releases?: number;
  /**
   * Seconds a release's assets are kept after the build that replaced it.
   * Default 7 days. Checked when the next build runs, so a release is served
   * at least this long, and longer if nothing is deployed in between.
   */
  maxAge?: number;
}

export interface ResolvedPreviousAssets {
  from: string;
  releases: number;
  maxAgeMs: number;
}

export interface RetainedRelease {
  /** When the build that replaced this release ran, ISO 8601. */
  retiredAt: string;
  /** Paths relative to `dist/client`, e.g. `assets/Dashboard-CRSTVHPB.js`. */
  files: string[];
}

/** Relative to `dist/client`; beside Vite's own manifest, so never served. */
export const PREVIOUS_ASSETS_RECORD = ".vite/previous-assets.json";

export const DEFAULT_RETAINED_RELEASES = 2;
export const DEFAULT_RETAINED_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const ASSETS_DIR = "assets";

/**
 * The retention to apply to this build, or `undefined` when it is off.
 *
 * On when `GEMI_PREVIOUS_ASSETS` names a directory (which then wins as
 * `from`) or `gemi.config.ts` sets `previousAssets`. Off by default: a local
 * `gemi build` should not accumulate every earlier build's chunks.
 */
export function resolvePreviousAssets(
  configured: PreviousAssetsConfig | boolean | undefined,
  rootDir: string,
  env: string | undefined = process.env.GEMI_PREVIOUS_ASSETS,
): ResolvedPreviousAssets | undefined {
  const fromEnv = env?.trim();
  if (!fromEnv && !configured) {
    return undefined;
  }
  const config = typeof configured === "object" ? configured : {};
  const from = fromEnv || config.from || join("dist", "client");
  const releases = config.releases ?? DEFAULT_RETAINED_RELEASES;
  const maxAge = config.maxAge ?? DEFAULT_RETAINED_MAX_AGE_SECONDS;
  if (!Number.isInteger(releases) || releases < 0) {
    throw new Error(`previousAssets.releases must be a whole number ≥ 0, got ${releases}`);
  }
  if (!(maxAge >= 0)) {
    throw new Error(`previousAssets.maxAge must be a number of seconds ≥ 0, got ${maxAge}`);
  }
  return {
    from: isAbsolute(from) ? from : resolve(rootDir, from),
    releases,
    maxAgeMs: maxAge * 1000,
  };
}

/**
 * Copies the assets worth keeping out of `options.from` into `stagingDir`,
 * before the client build empties `dist/client` (which `from` usually is).
 * Returns the releases they belong to, newest first, for
 * `restorePreviousAssets` to put back.
 */
export async function stagePreviousAssets(
  options: ResolvedPreviousAssets,
  stagingDir: string,
  now: Date = new Date(),
): Promise<RetainedRelease[]> {
  const { from } = options;
  if (!(await isDirectory(join(from, ASSETS_DIR)))) {
    console.log(`No previous assets at ${join(from, ASSETS_DIR)}; nothing to carry over.`);
    return [];
  }

  const carried = await readRecord(from);
  const carriedFiles = new Set(carried.flatMap((release) => release.files));
  // The outgoing release's own files: everything it served that it was not
  // itself only carrying for an earlier one.
  const own = (await listFiles(from, ASSETS_DIR)).filter((file) => !carriedFiles.has(file));

  const releases = [
    { retiredAt: now.toISOString(), files: own },
    ...carried.filter(
      (release) => now.getTime() - Date.parse(release.retiredAt) < options.maxAgeMs,
    ),
  ]
    .filter((release) => release.files.length > 0)
    .slice(0, options.releases);

  const kept: RetainedRelease[] = [];
  for (const release of releases) {
    const files: string[] = [];
    for (const file of release.files) {
      const source = inside(from, file);
      if (!source || !(await isFile(source))) {
        continue;
      }
      const target = join(stagingDir, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      files.push(file);
    }
    if (files.length > 0) {
      kept.push({ retiredAt: release.retiredAt, files });
    }
  }
  return kept;
}

/**
 * Puts the staged files into the freshly built `clientDir` and records them.
 *
 * A file the new build also wrote is left as the new build's: same name means
 * same content, and recording it as carried would let a later build drop a
 * file the then-outgoing release still needs.
 */
export async function restorePreviousAssets(
  stagingDir: string,
  clientDir: string,
  releases: RetainedRelease[],
): Promise<{ files: number; releases: number }> {
  const record: RetainedRelease[] = [];
  let count = 0;
  for (const release of releases) {
    const files: string[] = [];
    for (const file of release.files) {
      const target = inside(clientDir, file);
      if (!target || (await exists(target))) {
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(stagingDir, file), target);
      files.push(file);
    }
    if (files.length > 0) {
      record.push({ retiredAt: release.retiredAt, files });
      count += files.length;
    }
  }

  const recordPath = join(clientDir, PREVIOUS_ASSETS_RECORD);
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify({ releases: record }, null, 2)}\n`);
  return { files: count, releases: record.length };
}

async function readRecord(clientDir: string): Promise<RetainedRelease[]> {
  let raw: string;
  try {
    raw = await readFile(join(clientDir, PREVIOUS_ASSETS_RECORD), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const releases = JSON.parse(raw)?.releases;
  if (!Array.isArray(releases)) {
    return [];
  }
  return releases.filter(
    (release): release is RetainedRelease =>
      typeof release?.retiredAt === "string" &&
      !Number.isNaN(Date.parse(release.retiredAt)) &&
      Array.isArray(release.files) &&
      release.files.every((file: unknown) => typeof file === "string"),
  );
}

async function listFiles(root: string, dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

// A recorded path is data from a previous build; one that climbs out of the
// directory it names is refused rather than copied.
function inside(root: string, file: string): string | null {
  const path = resolve(root, file);
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] === ASSETS_DIR
    ? path
    : null;
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
