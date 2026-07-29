import { describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { UnsupportedQueryError } from "../errors";
import { lateralStrategy } from "./lateral";
import { batchedStrategy } from "./plan-relations";
import { defaultStrategy, resolveStrategy } from "./strategy";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

const origin = { model: "User", operation: "findMany" };

/**
 * `resolveStrategy` had no test, and its refusal reported `"Model"` as the
 * model and `"$exec"` as the operation — a base class, and something that is
 * not one of the thirteen operations (#112). Its one caller has both in scope.
 */
describe("resolveStrategy", () => {
  test("the default is per dialect: lateral on postgres, batched on sqlite", () => {
    expect(defaultStrategy(postgres)).toBe(lateralStrategy);
    expect(defaultStrategy(sqlite)).toBe(batchedStrategy);
    expect(resolveStrategy(undefined, postgres, origin)).toBe(lateralStrategy);
    expect(resolveStrategy(undefined, sqlite, origin)).toBe(batchedStrategy);
  });

  test.each([
    ["batched", batchedStrategy],
    ["lateral", lateralStrategy],
  ])("%s is honoured over the dialect's default", (named, expected) => {
    // Named on sqlite, whose default is `batched`, so `lateral` proves the name
    // is what decided rather than the dialect.
    expect(resolveStrategy(named, sqlite, origin)).toBe(expected);
  });

  /**
   * A typo raises rather than falling back — the reason `resolveStrategy`
   * gives is that a silent fallback would be a performance mystery with no
   * error attached.
   */
  test("an unknown name names the caller's query", () => {
    let error: UnsupportedQueryError | null = null;
    try {
      resolveStrategy("latteral", postgres, origin);
    } catch (raised) {
      error = raised as UnsupportedQueryError;
    }

    expect(error).toBeInstanceOf(UnsupportedQueryError);
    expect(error!.model).toBe("User");
    expect(error!.operation).toBe("findMany");
    // The value is quoted in the argument, so the message shows the typo back.
    expect(error!.argument).toBe(`strategy: "latteral"`);
  });
});
