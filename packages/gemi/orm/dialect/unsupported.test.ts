import { describe, expect, test } from "vitest";

import {
  UnsupportedDialectError,
  dialectFor,
  everyDialect,
  ormSupports,
} from "./index";

/**
 * MySQL and MariaDB: refused explicitly, which is #71's option (2) and the
 * minimum that should ship whichever way the long-term decision goes.
 *
 * The property worth pinning is not "it throws" — it already did — but **what
 * the refusal says**, because the obvious reading of "not supported" is wrong
 * in the expensive direction. `DatabaseManager` connects to both perfectly
 * well; Bun's client speaks all four dialects. Raw SQL and transactions work.
 * What does not exist is a `SqlDialect`, so only the *compiler* stops.
 *
 * A caller who concludes the connection is unusable will migrate a database
 * they did not need to.
 */

describe("a dialect the ORM does not implement", () => {
  test.each(["mysql", "mariadb"])("%s is refused", (dialect) => {
    expect(() => dialectFor(dialect as never)).toThrow(UnsupportedDialectError);
  });

  test.each(["sqlite", "postgres"])("%s resolves", (dialect) => {
    expect(dialectFor(dialect as never).name).toBe(dialect);
  });

  /**
   * The three things the message owes the reader: what is unavailable, what
   * still works, and what to do. #61's rule.
   */
  test("the message separates the compiler from the connection", () => {
    const run = () => dialectFor("mysql" as never);

    expect(run).toThrow(/does not support the 'mysql' dialect/);
    // What still works — the half a bare "not supported" hides.
    expect(run).toThrow(/The \*connection\* is fine/);
    expect(run).toThrow(/DB\.query/);
    // What to do.
    expect(run).toThrow(/Point DATABASE_URL at Postgres or SQLite/);
  });

  /**
   * It no longer says "yet". The word is the one #68 made load-bearing:
   * `distinct` and `cursor` say "a decision rather than a gap", genuinely
   * unimplemented arguments say "yet", and this is neither — it is a
   * *supported-matrix* statement, and "yet" invited a reader to wait for a
   * release that is not planned.
   */
  test("it states the supported set rather than promising more", () => {
    expect(() => dialectFor("mysql" as never)).toThrow(
      /Only sqlite and postgres are implemented/,
    );
    expect(() => dialectFor("mysql" as never)).not.toThrow(/dialect yet/);
  });

  /**
   * The predicate exists so an application can ask at boot instead of finding
   * out on its first model query — which is what `DatabaseServiceProvider`
   * uses it for.
   */
  test("ormSupports answers without throwing", () => {
    expect(ormSupports("sqlite")).toBe(true);
    expect(ormSupports("postgres")).toBe(true);
    expect(ormSupports("mysql")).toBe(false);
    expect(ormSupports("mariadb")).toBe(false);
  });

  /**
   * The two have to agree, or the boot check and the query-time failure would
   * disagree about which databases work — the check would be worse than none.
   *
   * Walked from `everyDialect()` rather than a hand-written list. The list this
   * used to carry was a *copy* of the `Dialect` union, so it only covered the
   * members someone had remembered to add — and adding a fifth changed nothing
   * anywhere, which is precisely the moment the guard exists for.
   *
   * The exhaustiveness itself is `tsc`'s now, via the `satisfies` on
   * `COMPILERS`; this checks the two functions agree in *behaviour*, which a
   * type cannot.
   */
  test("the predicate and the resolver cannot disagree", () => {
    const dialects = everyDialect();
    expect(dialects.length).toBeGreaterThan(1);

    for (const dialect of dialects) {
      let resolved = true;
      try {
        dialectFor(dialect);
      } catch {
        resolved = false;
      }
      expect(resolved, dialect).toBe(ormSupports(dialect));
    }
  });
});
