import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { type InstallSkillOptions, installSkill } from "./install-skill";
import { fetchPublishedVersion } from "./registry";
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
  for (const [manager, files] of LOCKFILES) {
    if (files.some((file) => existsSync(path.join(rootDir, file)))) {
      return manager;
    }
  }
  return "bun";
}

/**
 * Which dependency list `gemi` is declared in, so the install puts it back
 * where it was. `bun add` and friends default to `dependencies` and would
 * silently promote a dev-only gemi out of `devDependencies` — a diff nobody
 * asked for, in the file most likely to be reviewed line by line.
 */
export function dependencyKind(rootDir: string): "dependencies" | "devDependencies" | null {
  const manifestPath = path.join(rootDir, "package.json");
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

  const kind = dependencyKind(rootDir) ?? "dependencies";

  // An explicit target that already parses as a version is used as-is — that is
  // how you pin, and how you go *back* after an upgrade goes wrong. Anything
  // else is a dist-tag and has to be resolved, so the "already up to date"
  // comparison below has two real versions to compare.
  const explicitVersion = target && parseVersion(target) ? target : null;
  const tag = explicitVersion ? null : (target ?? channelFor(installed));

  let resolved: string | null = explicitVersion;
  if (!resolved) {
    log(`Resolving gemi@${tag}...`);
    resolved = await fetchPublishedVersion(tag!, { timeoutMs: 10_000, fetchImpl });
    if (!resolved) {
      error(
        `Could not resolve \`gemi@${tag}\` from the npm registry. Check your ` +
          `connection, or pass an explicit version: \`gemi upgrade 0.59.0\`.`,
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
      tag
        ? `gemi ${installed} is already the newest release on \`${tag}\`.`
        : `gemi is already at ${installed}.`,
    );
    return 0;
  }

  const spec = `gemi@${resolved}`;
  const cmd = installCommand(detectPackageManager(rootDir), spec, kind);

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

  const code = await spawn(cmd, rootDir);
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
