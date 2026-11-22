import type { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { slowTransactionThreshold } from "./config";

/**
 * The transactions waiting on each SQLite pool, as the promise the last one
 * queued settles (#1362). Bun's SQLite client runs every statement on one
 * connection, where a second `BEGIN` while a transaction is open fails with
 * "cannot start a transaction within a transaction". SQLite allows one writer
 * at a time anyway, so queueing changes the order, not the throughput.
 */
const sqliteQueues = new WeakMap<SQL, Promise<void>>();

/**
 * A transaction on a SQLite pool waited, in the queue, for one it is itself
 * inside (#1362). It would wait forever: the open transaction can't commit
 * until this one, which it is waiting on, has run.
 *
 * Thrown, rather than hung, when a transaction that isn't nested through the
 * ORM's scope starts from inside an open one on the same connection, and is
 * still waiting on it 5 seconds later: a raw
 * `sql.begin` (a store's), or code that deliberately left the transaction's
 * ORM scope while still awaited by it (an in-process API call or channel
 * message, `ormContext.exit`). Run that work after the commit
 * (`afterCommit`), or inside the transaction, where it becomes a savepoint.
 */
export class TransactionQueueDeadlockError extends Error {
  /**
   * Where the waiting statement or transaction was issued: an `Error` whose
   * stack is the call's. The error's own `stack` is this one too, so a log
   * points at the line rather than at the queue's timer.
   */
  readonly callSite: Error | undefined;

  constructor(
    kind: "transaction" | "statement" = "transaction",
    detail: { callSite?: Error; text?: string } = {},
  ) {
    const text = detail.text?.replace(/\s+/g, " ").trim();
    super(
      (kind === "statement"
        ? "A SQLite statement outside any transaction waited for the open transaction on its " +
          "connection, from inside that transaction's own async context (a write through the " +
          "pool instead of the transaction's handle: `DB.sql`, or a gemi store such as the " +
          "rate limiter, called inside `transaction()`; or an in-process call that left the " +
          "transaction's scope while the transaction waits on it). SQLite lets one writer at a " +
          "time in, so it would wait for the transaction that waits on it. Run it before the " +
          "transaction, after the commit (`afterCommit`), or inside it on its handle."
        : "A SQLite transaction started from inside an open transaction on the same connection, " +
          "outside its scope (a raw `begin`, or an in-process call that left the transaction's scope " +
          "while the transaction waits on it). SQLite runs one transaction per connection, so it " +
          "would wait for the transaction that waits on it. Run it after the commit (`afterCommit`), " +
          "or inside the transaction.") +
        (text ? ` Statement: ${text.length > 100 ? `${text.slice(0, 100)}…` : text}` : ""),
      detail.callSite ? { cause: detail.callSite } : undefined,
    );
    this.name = "TransactionQueueDeadlockError";
    this.callSite = detail.callSite;
    const frames = detail.callSite?.stack?.split("\n").slice(1).join("\n");
    if (frames) this.stack = `${this.name}: ${this.message}\n${frames}`;
  }
}

/** The transaction each SQLite pool's queue is running now: its token. */
const queueHolders = new WeakMap<SQL, object>();

/**
 * The queued transactions the current async context is inside of. An ORM
 * scope exit (`ormContext.exit`) doesn't leave this one, which is the point:
 * code that left the ORM scope on purpose is still awaited by the
 * transaction around it.
 */
const insideQueued = new AsyncLocalStorage<ReadonlySet<object>>();

/** How long a transaction waits in the queue before development warns. */
const QUEUE_WAIT_WARNING_MS = 5_000;

/**
 * `begin` once the transactions queued on `pool` before it have let it go
 * (#1362). Exported for the stores that open their own transactions on an
 * app connection, so every transaction on the pool takes the same turns.
 *
 * `release` lets the next one go. The ORM calls it first thing after COMMIT,
 * before the after-commit callbacks: `begin` resolves only after those have
 * run, and one that opened a transaction would otherwise wait on the very
 * transaction that waits on it. Settling lets it go too, so a caller that
 * ignores `release` (a raw `sql.begin`, whose commit is its settle) holds the
 * queue until its promise settles, including any work it does after its own
 * commit. `begin` must not queue on the same pool again from inside (it
 * would wait for itself; see below).
 *
 * Savepoints never come here: they run inside the open transaction.
 *
 * A transaction queued from inside the one holding the pool (its async
 * context says so) is only a suspected deadlock: async context is inherited
 * by work the transaction never waits for too (a `setTimeout`, an un-awaited
 * call), which just waits its turn. So it queues like any other, and is
 * rejected with `TransactionQueueDeadlockError` only if, after 5 seconds, it
 * is still waiting on a transaction it is inside. In development any
 * transaction still waiting then warns (`slowTransactionThreshold: false`
 * turns the warning off).
 */
export function queuedOnSqlite<T>(
  pool: SQL,
  begin: (release: () => void) => Promise<T>,
  options: {
    slowTransactionThreshold?: number | false;
    /** A plain statement waiting for its turn (`sqliteClient.ts`), for the error it fails with. */
    statement?: boolean;
    /** The statement's SQL, named by the deadlock error. */
    text?: string;
    /** Where the caller issued it, when it was captured earlier than this call. */
    callSite?: Error;
  } = {},
): Promise<T> {
  const inside = insideQueued.getStore();
  const kind = options.statement ? "statement" : "transaction";
  // Queued from inside the transaction holding the pool: the suspected
  // deadlock, and the one case the error needs a call site for. Captured in
  // every environment, and only here, so the normal path pays nothing.
  const holderNow = queueHolders.get(pool);
  const callSite =
    options.callSite ??
    (holderNow && inside?.has(holderNow) ? new Error(`${kind} queued here`) : undefined);
  const token = {};
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = () => {
      if (queueHolders.get(pool) === token) queueHolders.delete(pool);
      resolve();
    };
  });
  const previous = sqliteQueues.get(pool) ?? Promise.resolve();
  sqliteQueues.set(pool, released);

  return new Promise<T>((resolve, reject) => {
    let abandoned = false;
    // Only where it can be shown: a stack per transaction is not free.
    const site =
      slowTransactionThreshold(options.slowTransactionThreshold) === null
        ? undefined
        : (callSite ?? new Error(`${kind} queued here`));
    const timer = setTimeout(() => {
      // Still waiting. On a transaction it is inside: it can never get its
      // turn, so it fails, and lets the queue go when its turn would come.
      const holder = queueHolders.get(pool);
      if (holder && inside?.has(holder)) {
        abandoned = true;
        reject(new TransactionQueueDeadlockError(kind, { callSite, text: options.text }));
        return;
      }
      if (site) warnQueueWait(site, kind);
    }, QUEUE_WAIT_WARNING_MS);
    timer.unref?.();

    void previous.then(() => {
      clearTimeout(timer);
      if (abandoned) {
        release();
        return;
      }
      queueHolders.set(pool, token);
      const result = insideQueued.run(new Set([...(inside ?? []), token]), () => begin(release));
      result.then(release, release);
      result.then(resolve, reject);
    });
  });
}

/** Development's warning for a transaction or statement still waiting in the queue. */
function warnQueueWait(site: Error, kind: "transaction" | "statement"): void {
  const stack = site.stack?.split("\n").slice(1).join("\n") ?? "";
  console.warn(
    `[gemi] A SQLite ${kind} has waited ${QUEUE_WAIT_WARNING_MS}ms for the transaction open on its ` +
      `connection (SQLite lets one writer in at a time). Look for a long transaction, or ` +
      `one that waits on work started outside it.\n${stack}\n` +
      `(development only; database.slowTransactionThreshold: false switches it off)`,
  );
}

/**
 * Whether the current async context is inside the transaction holding
 * `pool`'s queue: a statement issued now would be a suspected deadlock if it
 * had to wait. Cheap: what a statement checks before capturing a stack.
 */
export function insideQueueHolder(pool: SQL): boolean {
  const holder = queueHolders.get(pool);
  return holder !== undefined && insideQueued.getStore()?.has(holder) === true;
}
