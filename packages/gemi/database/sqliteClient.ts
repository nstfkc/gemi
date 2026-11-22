import type { SQL } from "bun";
import { queuedOnSqlite } from "./sqliteQueue";

/**
 * Two Bun clients for one SQLite file (#1375): one for transactions, one for
 * every statement outside a transaction.
 *
 * Bun runs every statement of a SQLite client on one connection. With a
 * single client, a plain statement that ran while another request's
 * transaction was open ran *inside* it: it saw that transaction's
 * uncommitted rows, and committed or rolled back with it. Two clients are two
 * connections, so a transaction is isolated from everything else again.
 *
 * Both are in WAL mode, where a reader never waits for a writer. A writer
 * still waits for the one open write transaction, and that wait can't be
 * SQLite's own: Bun runs SQLite synchronously on the main thread, so
 * `busy_timeout` would block the event loop, and with it the transaction it
 * waits for, until it gave up. So both clients keep `busy_timeout = 0` and a
 * statement that meets the lock fails at once with `SQLITE_BUSY`, having done
 * nothing. Such a statement takes a turn in the connection's transaction
 * queue (#1362), where no transaction of this process is open, and runs
 * again there. Transactions open with `BEGIN IMMEDIATE`, so one that read
 * first can't fail later, at its first write, because a plain write landed in
 * between.
 *
 * What this module returns is a stand-in for the plain client: callable and
 * shaped like Bun's `SQL`, with queries that stay lazy until awaited. Its
 * `begin`, `transaction` and `reserve` go to the transaction client, so every
 * transaction on the connection, the stores' raw ones included, holds the
 * same connection's write lock.
 */

/** How long a statement that has its turn keeps retrying a lock held by another process. */
const BUSY_DEADLINE_MS = 5_000;

/**
 * A multi-statement string (`unsafe`, `file`) that met the lock of another
 * process. It isn't run again: the statements before the one that met the
 * lock may have committed, and running the whole string twice would repeat
 * them.
 */
export class SqliteBusyError extends Error {
  constructor(cause: unknown) {
    super(
      "A multi-statement SQL string on SQLite met the database lock (SQLITE_BUSY) of another " +
        "connection. It was not run again, because the statements before the one that failed " +
        "may have committed. Run the statements one per call, or inside a transaction.",
      { cause },
    );
    this.name = "SqliteBusyError";
  }
}

/** `SQLITE_BUSY` or one of its extended codes. Never `SQLITE_LOCKED`, which a retry can't fix. */
export function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * Whether a SQL string holds more than one statement. A `;` followed by
 * anything but whitespace counts, even inside a string literal: a false
 * positive only means the string runs in a turn of its own and isn't retried.
 */
export function isMultiStatement(text: string): boolean {
  const at = text.indexOf(";");
  return at !== -1 && text.slice(at + 1).replace(/[\s;]/g, "") !== "";
}

/** The pragmas each client gets, in order, before anything else it runs. */
export const SQLITE_FILE_PRAGMAS = [
  "pragma journal_mode = WAL",
  "pragma busy_timeout = 0",
  "pragma foreign_keys = ON",
];

/** Whether a SQLite client is on a file, which a second connection can open, rather than in memory. */
export function isFileDatabase(client: SQL): boolean {
  const options = (client as { options?: { adapter?: string; filename?: unknown } }).options;
  if (options?.adapter !== "sqlite") return false;
  const filename = typeof options.filename === "string" ? options.filename : "";
  return filename !== "" && !filename.includes(":memory:") && !/[?&]mode=memory\b/.test(filename);
}

type Query = PromiseLike<unknown> & Record<PropertyKey, any>;

const standIns = new WeakSet<object>();

/**
 * Whether `sql` waits out `SQLITE_BUSY` itself, in JS (a SQLite file's
 * client, #1375). A store that would otherwise give the connection a
 * `busy_timeout` leaves it at 0 then: SQLite's own wait blocks the event
 * loop, and against this process's own open transaction it can only time out.
 */
export function retriesSqliteBusy(sql: unknown): boolean {
  return typeof sql === "function" && standIns.has(sql);
}

/** What a stand-in query was built from, so a template that nests one gets Bun's own back. */
const underlying = new WeakMap<object, Query>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The plain client's stand-in. `plain` runs statements outside transactions,
 * `transactions` runs transactions. The queue is keyed by the stand-in, which
 * is the `sql` everything else holds.
 */
export function plainSqliteClient(plain: SQL, transactions: SQL): SQL {
  const bound = new Map<PropertyKey, unknown>();

  /**
   * `begin(fn)` opens `BEGIN IMMEDIATE`; a mode the caller spelled is kept.
   * A `BEGIN` that met another process's lock did nothing and ran none of
   * `fn`, so it is tried again, with a backoff, until the deadline. Once
   * `fn` has started, an error is the transaction's and goes to the caller.
   */
  const begin = async (...args: unknown[]) => {
    const fn = args[args.length - 1] as (tx: unknown) => unknown;
    const mode = typeof args[0] === "function" ? ["immediate"] : args.slice(0, -1);
    const deadline = Date.now() + BUSY_DEADLINE_MS;
    for (let attempt = 0; ; attempt++) {
      let started = false;
      try {
        return await (transactions.begin as (...a: unknown[]) => Promise<unknown>)(
          ...mode,
          (tx: unknown) => {
            started = true;
            return fn(tx);
          },
        );
      } catch (error) {
        if (started || !isSqliteBusy(error) || Date.now() >= deadline) throw error;
        await sleep(Math.min(2 ** attempt, 50));
      }
    }
  };

  let self: SQL;

  /**
   * A query that runs again in a queue turn when it met the lock. `make`
   * builds a fresh Bun query (a query runs once); `first` is the one already
   * built. `multi` strings take a turn before running and never run twice.
   */
  const wrap = (make: () => Query, first: Query, multi: boolean): Query => {
    const modifiers: [PropertyKey, unknown[]][] = [];
    let current = first;
    let running: Promise<unknown> | undefined;

    const prepare = (query: Query) => {
      for (const [name, args] of modifiers) query[name](...args);
      return query;
    };
    const fresh = () => (current = prepare(make()));

    const inTurn = (fn: () => Promise<unknown>) =>
      queuedOnSqlite(self, () => fn(), { statement: true });

    const run = async (): Promise<unknown> => {
      if (multi) {
        return inTurn(async () => {
          try {
            return await prepare(current);
          } catch (error) {
            throw isSqliteBusy(error) ? new SqliteBusyError(error) : error;
          }
        });
      }
      try {
        return await prepare(current);
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
      }
      // No transaction of this process is open during the turn. A lock still
      // met is another process's, retried with a backoff until the deadline.
      return inTurn(async () => {
        const deadline = Date.now() + BUSY_DEADLINE_MS;
        for (let attempt = 0; ; attempt++) {
          try {
            return await fresh();
          } catch (error) {
            if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
            await sleep(Math.min(2 ** attempt, 50));
          }
        }
      });
    };
    const start = () => (running ??= run());

    const proxy: Query = new Proxy(first, {
      get(target, prop) {
        switch (prop) {
          case "then":
            return (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              start().then(resolve, reject);
          case "catch":
            return (reject?: (e: unknown) => unknown) => start().catch(reject);
          case "finally":
            return (fn?: () => void) => start().finally(fn);
          case "execute":
            return () => {
              void start().catch(() => {});
              return proxy;
            };
          case "values":
          case "raw":
          case "simple":
            return (...args: unknown[]) => {
              if (!running) modifiers.push([prop, args]);
              return proxy;
            };
          case "cancel":
            return () => current.cancel();
          case "active":
          case "cancelled":
            return current[prop];
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    underlying.set(proxy, first);
    return proxy;
  };

  const unwrap = (values: unknown[]) =>
    values.map((value) => (value && underlying.get(value as object)) ?? value);

  self = new Proxy(plain, {
    apply(target, _this, args: unknown[]) {
      const [strings, ...values] = args;
      // A tagged template is a query; `sql(obj)`, `sql("name")` are helpers.
      if (!Array.isArray(strings) || !("raw" in strings)) {
        return Reflect.apply(target, target, [strings, ...unwrap(values)]);
      }
      const call = [strings, ...unwrap(values)];
      const make = () => Reflect.apply(target, target, call) as Query;
      return wrap(make, make(), false);
    },
    get(target, prop) {
      switch (prop) {
        case "unsafe":
          return (text: string, params?: unknown[]) => {
            const make = () => target.unsafe(text, params as never) as unknown as Query;
            return wrap(make, make(), isMultiStatement(text));
          };
        case "file":
          return (path: string, params?: unknown[]) => {
            const make = () => target.file(path, params as never) as unknown as Query;
            return wrap(make, make(), true);
          };
        case "begin":
        case "transaction":
          return begin;
        case "reserve":
          return transactions.reserve.bind(transactions);
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (!bound.has(prop)) bound.set(prop, value.bind(target));
      return bound.get(prop);
    },
  }) as SQL;
  standIns.add(self);
  return self;
}
