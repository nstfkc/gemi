import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { type InstallSkillOptions, installSkill } from "./install-skill";
import { fetchNewestPublished, fetchPublishedVersion } from "./registry";
import { channelFor, compareVersions, parseVersion, readInstalledVersion } from "./version";

/**
 * `gemi upgrade` — resolve a target version and hand the install to the
 * project's package manager.
 *
 * It deliberately does not write `package.json` or touch the lockfile itself.
 * Editing the manifest and leaving the lockfile stale is how a project ends up
 * with a dependency graph nothing can reproduce, and every package manager
 * already does this correctly. So this command's job is the two things the
 * package manager cannot do for you: pick the right version for the channel you
 * are on, and say what changed.
 */

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

// Ordered: a repo carrying two lockfiles has one that is actually maintained,
// and for a gemi project that is overwhelmingly bun's. Checked before the
// others rather than alphabetically for that reason.
const LOCKFILES: Array<[PackageManager, string[]]> = [
  ["bun", ["bun.lock", "bun.lockb"]],
  ["pnpm", ["pnpm-lock.yaml"]],
  ["yarn", ["yarn.lock"]],
  ["npm", ["package-lock.json"]],
];

/**
 * The package manager the project is installed with, inferred from its
 * lockfile. Defaults to bun — gemi's runtime, test runner and bundler are Bun,
 * and the templates ship a `bun.lock`.
 */
export function detectPackageManager(rootDir: string): PackageManager {
  // Walks up, because a workspace keeps one lockfile at its root while the
  // package being upgraded is several directories below it. Stopping at
  // `rootDir` would report bun's default for a pnpm monorepo and then run the
  // wrong package manager against it.
  let dir = path.resolve(rootDir);
  while (true) {
    for (const [manager, files] of LOCKFILES) {
      if (files.some((file) => existsSync(path.join(dir, file)))) return manager;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "bun";
    dir = parent;
  }
}

/**
 * Which dependency list `gemi` is declared in, so the install puts it back
 * where it was. `bun add` and friends default to `dependencies` and would
 * silently promote a dev-only gemi out of `devDependencies` — a diff nobody
 * asked for, in the file most likely to be reviewed line by line.
 */
export function dependencyKind(dir: string): "dependencies" | "devDependencies" | null {
  const manifestPath = path.join(dir, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest?.dependencies?.gemi) return "dependencies";
    if (manifest?.devDependencies?.gemi) return "devDependencies";
    return null;
  } catch {
    return null;
  }
}

/**
 * The directory whose `package.json` declares gemi, searched upwards from
 * `rootDir`, with the list it is declared in.
 *
 * The install has to run *there*, not at `rootDir` and not beside the hoisted
 * `node_modules/gemi`. In a workspace those are three different places: gemi is
 * declared in `apps/web/package.json`, installed to the monorepo root's
 * `node_modules`, and the user may be standing in either. Running `bun add` at
 * `rootDir` when gemi is declared one level up adds a direct dependency to a
 * manifest that never had one, leaves the real range untouched, and changes
 * nothing about the installed version — a no-op that edits the wrong file.
 *
 * `null` when no manifest above `rootDir` declares gemi at all. That is a
 * refusal rather than a default, because the only thing left to do would be to
 * add it somewhere it was never declared.
 */
export function findDeclaringDir(
  rootDir: string,
): { dir: string; kind: "dependencies" | "devDependencies" } | null {
  let dir = path.resolve(rootDir);
  while (true) {
    const kind = dependencyKind(dir);
    if (kind) return { dir, kind };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The argv the package manager is spawned with. */
export function installCommand(
  manager: PackageManager,
  spec: string,
  kind: "dependencies" | "devDependencies",
): string[] {
  const dev = kind === "devDependencies";
  switch (manager) {
    case "bun":
      return ["bun", "add", ...(dev ? ["--dev"] : []), spec];
    case "pnpm":
      return ["pnpm", "add", ...(dev ? ["--save-dev"] : []), spec];
    case "yarn":
      return ["yarn", "add", ...(dev ? ["--dev"] : []), spec];
    case "npm":
      return ["npm", "install", ...(dev ? ["--save-dev"] : ["--save-prod"]), spec];
  }
}

export interface UpgradeOptions {
  rootDir: string;
  /** An explicit version or dist-tag to move to. Defaults to the current channel's tag. */
  target?: string;
  /** Print the plan and the command, run nothing. */
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  error?: (message: string) => void;
  spawn?: (cmd: string[], cwd: string) => Promise<number>;
  installSkillImpl?: (options: InstallSkillOptions) => number;
}

async function defaultSpawn(cmd: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  await proc.exited;
  return proc.exitCode ?? 1;
}

/**
 * Returns the process exit code. Every failure is a sentence and a non-zero
 * code, never a thrown stack — this is a command a user runs by hand, and the
 * things that go wrong with it (offline, not a gemi project, a tag that does
 * not exist) are all ordinary.
 */
export async function runUpgrade(options: UpgradeOptions): Promise<number> {
  const {
    rootDir,
    target,
    dryRun = false,
    fetchImpl,
    log = console.log,
    error = console.error,
    spawn = defaultSpawn,
    installSkillImpl = installSkill,
  } = options;

  const installed = readInstalledVersion(rootDir);
  if (!installed) {
    error(
      `Could not find an installed gemi under ${rootDir}. Run this from the ` +
        `root of a gemi project (one with \`gemi\` in its node_modules).`,
    );
    return 1;
  }

  // Where gemi is *declared*, which in a workspace is neither `rootDir` nor the
  // directory holding the hoisted `node_modules/gemi`.
  const declaring = findDeclaringDir(rootDir);
  if (!declaring) {
    error(
      `No \`package.json\` at or above ${rootDir} declares \`gemi\` as a ` +
        `dependency, so there is nothing to upgrade. Run this from the ` +
        `directory whose manifest depends on gemi.`,
    );
    return 1;
  }
  const { dir: installDir, kind } = declaring;

  // An explicit target that already parses as a version is used as-is — that is
  // how you pin, and how you go *back* after an upgrade goes wrong. Anything
  // else is a dist-tag and has to be resolved, so the "already up to date"
  // comparison below has two real versions to compare.
  const explicitVersion = target && parseVersion(target) ? target : null;
  const tag = explicitVersion ? null : target;

  let resolved: string | null = explicitVersion;
  if (!resolved) {
    log(`Resolving gemi@${tag ?? channelFor(installed)}...`);
    resolved = tag
      ? // An explicitly named tag is the user's choice, and is asked for
        // literally — `gemi upgrade rc` must land on `rc` even when `latest` is
        // ahead of it.
        await fetchPublishedVersion(tag, { timeoutMs: 10_000, fetchImpl })
      : // With no argument, both the installed version's channel and `latest`,
        // newest wins. A frozen prerelease tag would otherwise report the user
        // current while `latest` runs minors ahead — see `fetchNewestPublished`.
        await fetchNewestPublished(installed, { timeoutMs: 10_000, fetchImpl });
    if (!resolved) {
      error(
        `Could not resolve \`gemi@${tag ?? channelFor(installed)}\` from the npm ` +
          `registry. Check your connection, or pass an explicit version: ` +
          `\`gemi upgrade 0.59.0\`.`,
      );
      return 1;
    }
  }

  const direction = compareVersions(resolved, installed);
  if (direction === 0) {
    // Two different sentences, because "already the latest on `latest`" is only
    // true of a resolved tag. `gemi upgrade 0.59.0` on 0.59.0 has no tag to name
    // and saying it does would be a claim the command never checked.
    log(
      explicitVersion
        ? `gemi is already at ${installed}.`
        : tag
          ? `gemi ${installed} is already the newest release on \`${tag}\`.`
          : `gemi ${installed} is already the newest release published.`,
    );
    return 0;
  }

  const spec = `gemi@${resolved}`;
  const cmd = installCommand(detectPackageManager(installDir), spec, kind);

  log(
    direction > 0
      ? `Upgrading gemi ${installed} → ${resolved}`
      : `Downgrading gemi ${installed} → ${resolved}`,
  );

  const from = parseVersion(installed);
  const to = parseVersion(resolved);
  // Same rule as the `dev` notice: pre-1.0 the minor is where breaking changes
  // land, and UPGRADE.md is written per minor.
  if (from && to && (from.core[0] !== to.core[0] || from.core[1] !== to.core[1])) {
    log(
      `\nThis crosses a minor version. UPGRADE.md documents what each one ` +
        `requires — read it before running your app:\n` +
        `  https://github.com/nstfkc/gemi/blob/main/UPGRADE.md\n`,
    );
  }

  if (dryRun) {
    log(`Would run: ${cmd.join(" ")}`);
    return 0;
  }

  const code = await spawn(cmd, installDir);
  if (code !== 0) {
    error(`\n\`${cmd.join(" ")}\` failed with exit code ${code}.`);
    return code;
  }

  log(`\ngemi is now ${resolved}.`);

  // The shipped agent skill documents this version of the framework, so it is
  // refreshed from the package that was just installed. `onlyIfInstalled` keeps
  // this to projects that ran `gemi install-skill` — an upgrade is not the moment
  // to add a directory nobody asked for.
  //
  // Its exit code is deliberately not this command's: the package upgrade
  // succeeded, and a skill copy that was declined (local edits, needing --force)
  // is a note, not a failed upgrade.
  installSkillImpl({ rootDir, onlyIfInstalled: true, log, error });

  return 0;
}
