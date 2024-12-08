import * as crypto from "crypto";
import * as path from "path";
import { execSync } from "child_process";

/**
 * Generates a deterministic ID based on file changes in specified folders
 * @param basePath Base directory to run git diff (defaults to current process directory)
 * @param monitoredFolders Array of folder paths to monitor for changes
 * @param diffOptions Additional git diff options
 * @returns Unique hash identifier for the changes
 */
export function generateGitDiffId(
  basePath: string = process.cwd(),
  monitoredFolders: string[] = [],
  diffOptions: string = "",
): string {
  // Change to the specified base path
  process.chdir(basePath);

  // Construct the git diff command
  const diffCommand = constructDiffCommand(monitoredFolders, diffOptions);

  try {
    // Execute git diff command
    const gitDiff = execSync(diffCommand, { encoding: "utf-8" });

    // Normalize and hash the diff
    return generateHash(normalizeDiff(gitDiff));
  } catch (error) {
    // Handle potential errors (e.g., not a git repository, no changes)
    if (error instanceof Error) {
      console.error("Error generating git diff:", error.message);
    }
    return generateHash("");
  }
}

/**
 * Constructs the git diff command based on monitored folders and options
 * @param monitoredFolders Folders to monitor
 * @param additionalOptions Additional git diff options
 * @returns Constructed git diff command
 */
function constructDiffCommand(
  monitoredFolders: string[],
  additionalOptions: string,
): string {
  // Start with base diff command
  let command = "git diff";

  // Add any additional options
  if (additionalOptions) {
    command += ` ${additionalOptions}`;
  }

  // Add monitored folders if specified
  if (monitoredFolders && monitoredFolders.length > 0) {
    command +=
      " -- " +
      monitoredFolders.map((folder) => path.normalize(folder)).join(" ");
  }

  return command;
}

/**
 * Normalizes the git diff output for consistent processing
 * @param gitDiff Raw git diff string
 * @returns Normalized diff string
 */
function normalizeDiff(gitDiff: string): string {
  // Remove unnecessary whitespace and normalize line endings
  return gitDiff.trim().replace(/\r\n/g, "\n").replace(/\s+/g, " ");
}

/**
 * Generates a consistent hash from the filtered changes
 * @param changes Filtered diff string
 * @returns Deterministic hash identifier
 */
function generateHash(changes: string): string {
  // Use SHA-256 for consistent, deterministic hashing
  return crypto.createHash("sha256").update(changes).digest("hex");
}
