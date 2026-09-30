import { InvalidArgumentError } from "../errors";
import type { RowLockMode } from "../types";

/**
 * A read's `lock` argument, validated and normalised: one strength and one
 * answer to "what if another transaction holds the row".
 *
 * The dialect turns this into SQL (`SqlDialect.rowLock`); the compiler never
 * spells a lock clause itself.
 */
export interface RowLockClause {
  mode: RowLockMode;
  /** `wait` blocks, `skipLocked` leaves the row out, `noWait` fails at once. */
  onLocked: "wait" | "skipLocked" | "noWait";
}

const MODES = new Set<string>(["update", "share"]);
const OBJECT_KEYS = new Set(["mode", "skipLocked", "noWait"]);

const EXPECTED =
  `Expected "update", "share", or { mode: "update" | "share", ` +
  `skipLocked?: boolean, noWait?: boolean }.`;

/**
 * Validates `lock` and returns what it asks for, or `undefined` for no lock.
 *
 * Strict for the reason every argument here is: a lock that is silently not
 * taken is a race that reads as fixed. So an unknown key, a misspelt mode or
 * both `skipLocked` and `noWait` at once raise rather than degrade to a plain
 * read.
 */
export function parseRowLock(
  lock: unknown,
  model: string,
  operation: string,
): RowLockClause | undefined {
  if (lock === undefined) return undefined;

  if (typeof lock === "string") {
    if (MODES.has(lock)) {
      return { mode: lock as RowLockMode, onLocked: "wait" };
    }
    throw new InvalidArgumentError("lock", model, operation, EXPECTED);
  }

  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    throw new InvalidArgumentError("lock", model, operation, EXPECTED);
  }

  const record = lock as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!OBJECT_KEYS.has(key)) {
      throw new InvalidArgumentError(
        `lock.${key}`,
        model,
        operation,
        `A lock takes mode, skipLocked and noWait.`,
      );
    }
  }

  if (typeof record.mode !== "string" || !MODES.has(record.mode)) {
    throw new InvalidArgumentError("lock.mode", model, operation, EXPECTED);
  }

  for (const key of ["skipLocked", "noWait"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      throw new InvalidArgumentError(
        `lock.${key}`,
        model,
        operation,
        `Expected a boolean.`,
      );
    }
  }

  if (record.skipLocked === true && record.noWait === true) {
    throw new InvalidArgumentError(
      "lock",
      model,
      operation,
      `'skipLocked' and 'noWait' cannot both be set: a row another ` +
        `transaction holds is either left out of the result or fails the ` +
        `statement, not both.`,
    );
  }

  return {
    mode: record.mode as RowLockMode,
    onLocked:
      record.skipLocked === true
        ? "skipLocked"
        : record.noWait === true
          ? "noWait"
          : "wait",
  };
}
