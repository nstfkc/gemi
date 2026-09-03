import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { findGemiPackageDir, readInstalledVersion } from "./version";

/**
 * `gemi install-skill` — copy the agent skill that ships with the installed gemi
 * into the app's `.agents/skills/`.
 *
 * The skill documents the framework, so its correct version is the framework's
 * version. That is the whole reason this is a command rather than a file you
 * copy once: `gemi upgrade` re-runs it, so the rules an agent reads cannot drift
 * from the gemi the app actually runs.
 *
 * The layout and the lockfile shape follow the `vercel-labs/skills` convention
 * already on disk for other skills, so a project can hold gemi's skill and
 * skills from elsewhere in one directory without either tool confusing the
 * other's entries.
 */

export const SKILL_NAME = "gemi-react-best-practices";

/** Where the skill ships inside the gemi package. */
export function skillSourceDir(gemiPackageDir: string): string {
  return path.join(gemiPackageDir, "skills", SKILL_NAME);
}

/** Where it is installed in the app. */
export function skillTargetDir(rootDir: string): string {
  return path.join(rootDir, ".agents", "skills", SKILL_NAME);
}

export function lockPath(rootDir: string): string {
  return path.join(rootDir, ".agents", ".skill-lock.json");
}

/** Whether this app has the skill installed — what `upgrade` checks. */
export function isSkillInstalled(rootDir: string): boolean {
  return existsSync(path.join(skillTargetDir(rootDir), "SKILL.md"));
}

/**
 * A content hash of a skill directory: every file's relative path and bytes, in
 * sorted order. Paths are part of the digest so that renaming or deleting a rule
 * changes it — a hash over concatenated contents alone would not notice a file
 * moving, which is exactly what a rule rename is.
 *
 * Used to tell "the installed copy is the one we wrote" from "someone edited it",
 * so an update can refuse to discard local edits.
 */
export function hashDirectory(dir: string): string {
  const hash = createHash("sha1");
  const walk = (current: string, prefix: string) => {
    const entries = readdirSync(current, { withFileTypes: true })
      // Sorted, because readdir order is filesystem-dependent and a hash that
      // varies by machine would report every install as locally modified.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile()) {
        hash.update(relative);
        hash.update("\0");
        hash.update(readFileSync(full));
        hash.update("\0");
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

interface LockEntry {
  source: string;
  sourceType: string;
  skillPath: string;
  skillFolderHash: string;
  version?: string;
  installedAt: string;
  updatedAt: string;
}

interface Lock {
  version: number;
  skills: Record<string, LockEntry>;
  [key: string]: unknown;
}

/**
 * Read `.agents/.skill-lock.json`, tolerating both "not there yet" and "there but
 * damaged". A malformed lock must not block an install: the lock is a record of
 * what happened, not the authority on what is on disk.
 *
 * Unknown top-level keys are preserved on write — the file is shared with other
 * skill tooling, which keeps its own state there (`dismissed`,
 * `lastSelectedAgents`, …).
 */
export function readLock(rootDir: string): Lock {
  const empty: Lock = { version: 3, skills: {} };
  const file = lockPath(rootDir);
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return empty;
    return {
      ...parsed,
      version: typeof parsed.version === "number" ? parsed.version : 3,
      skills: parsed.skills && typeof parsed.skills === "object" ? parsed.skills : {},
    };
  } catch {
    return empty;
  }
}

export function writeLock(rootDir: string, lock: Lock): void {
  mkdirSync(path.dirname(lockPath(rootDir)), { recursive: true });
  writeFileSync(lockPath(rootDir), `${JSON.stringify(lock, null, 2)}\n`);
}

export interface InstallSkillOptions {
  rootDir: string;
  /** Overwrite an installed copy that has been edited locally. */
  force?: boolean;
  /**
   * Only act when the skill is already installed, and stay silent when it is
   * not. This is how `gemi upgrade` keeps an existing install current without
   * installing the skill into projects that never asked for it.
   */
  onlyIfInstalled?: boolean;
  log?: (message: string) => void;
  error?: (message: string) => void;
  now?: () => string;
}

/** Returns the process exit code. Every failure is a sentence, never a stack. */
export function installSkill(options: InstallSkillOptions): number {
  const {
    rootDir,
    force = false,
    onlyIfInstalled = false,
    log = console.log,
    error = console.error,
    now = () => new Date().toISOString(),
  } = options;

  if (onlyIfInstalled && !isSkillInstalled(rootDir)) return 0;

  const packageDir = findGemiPackageDir(rootDir);
  if (!packageDir) {
    error(
      `Could not find an installed gemi under ${rootDir}. Run this from the ` +
        `root of a gemi project (one with \`gemi\` in its node_modules).`,
    );
    return 1;
  }

  const source = skillSourceDir(packageDir);
  if (!existsSync(path.join(source, "SKILL.md"))) {
    error(
      `The installed gemi does not ship the \`${SKILL_NAME}\` skill (looked in ` +
        `${source}). It was added in a later release — run \`gemi upgrade\` first.`,
    );
    return 1;
  }

  const target = skillTargetDir(rootDir);
  const lock = readLock(rootDir);
  const recorded = lock.skills[SKILL_NAME];
  const existing = existsSync(target) ? hashDirectory(target) : null;

  // Refuse to discard edits. The lock records the hash of what was written, so a
  // mismatch means the copy on disk is not the copy this command produced. A
  // missing lock entry beside an existing directory is the same situation: it was
  // put there by something other than this command.
  if (existing !== null && !force) {
    if (!recorded) {
      error(
        `${path.relative(rootDir, target) || target} already exists and was not ` +
          `installed by \`gemi install-skill\`. Re-run with --force to replace it.`,
      );
      return 1;
    }
    if (recorded.skillFolderHash !== existing) {
      error(
        `${path.relative(rootDir, target) || target} has local edits. Re-run with ` +
          `--force to discard them and install the version shipped with gemi.`,
      );
      return 1;
    }
  }

  const version = readInstalledVersion(rootDir) ?? undefined;
  const sourceHash = hashDirectory(source);

  if (existing !== null && existing === sourceHash) {
    // Nothing to do, and saying so beats a silent success that looks like a
    // no-op failure.
    log(`${SKILL_NAME} is already up to date${version ? ` (gemi ${version})` : ""}.`);
    return 0;
  }

  // Replace rather than merge: a rule deleted or renamed upstream has to
  // disappear here too, and `cpSync` over the top would leave the old file
  // behind for an agent to keep reading.
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });

  const timestamp = now();
  lock.skills[SKILL_NAME] = {
    source: "gemi",
    sourceType: "npm",
    skillPath: `skills/${SKILL_NAME}/SKILL.md`,
    skillFolderHash: sourceHash,
    ...(version ? { version } : {}),
    installedAt: recorded?.installedAt ?? timestamp,
    updatedAt: timestamp,
  };
  writeLock(rootDir, lock);

  const where = path.relative(rootDir, target) || target;
  log(
    existing === null
      ? `Installed ${SKILL_NAME} to ${where}${version ? ` (gemi ${version})` : ""}.`
      : `Updated ${SKILL_NAME} in ${where}${version ? ` (gemi ${version})` : ""}.`,
  );
  return 0;
}
