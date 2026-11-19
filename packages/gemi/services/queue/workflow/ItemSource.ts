import { app } from "../../../foundation/app";
import { QueueManager } from "../QueueManager";
import { type Duration, toMilliseconds } from "./duration";
import type { WorkflowStore } from "./WorkflowStore";

declare const itemType: unique symbol;

/**
 * A stored list: what `ItemSource.write` and `step.source` resolve to, and
 * what `step.each` takes as its `source`. Small, so it can be a step's result.
 */
export type SourceRef<T = unknown> = {
  /** The source's id. */
  id: string;
  /** How many items it holds. */
  count: number;
  /** The item type, carried only in the type. */
  readonly [itemType]?: T;
};

/** The most one item may be, as JSON, in bytes. */
export const ITEM_SOURCE_ITEM_LIMIT = 64 * 1024;

/** How many items one insert writes. */
const WRITE_CHUNK = 500;

/** What `write` takes: a list, or anything that yields one, sync or async. */
export type ItemSourceInput<T> = Iterable<T> | AsyncIterable<T>;

/**
 * Lists kept in a table of the queue's database (#1309), item by item, so a
 * long list (the rows of an uploaded file, a snapshot of ids) lives between
 * the steps of a workflow without being held in memory or in a step's
 * result. `step.each({ source })` reads it a window at a time.
 *
 * ```ts
 * const rows = await ItemSource.write(`import:${importId}`, parseRows(file.stream()));
 * await ImportWorkflow.start(importId, rows);
 * // In the workflow: step.each("rows", { source: rows }, (row, ctx) => …)
 * ```
 *
 * Inside a workflow, prefer `step.source(key, fn)`: the list is written once,
 * and deleted with the workflow when it is pruned.
 */
export class ItemSource {
  /**
   * Writes `items` under `id`, replacing what was there, and resolves to the
   * source. Items are written as they come, 500 per insert, so an async
   * iterable (a parser over a stream) is never held in memory whole. Each
   * item is JSON, at most 64 KB. Not atomic: a write that fails part way
   * leaves the items so far; write it again.
   */
  static write<T>(id: string, items: ItemSourceInput<T>): Promise<SourceRef<T>> {
    return writeSource(storeOf(), id, items, null);
  }

  /** The item at `index`, or `undefined`. */
  static async read<T = unknown>(id: string, index: number): Promise<T | undefined> {
    const [row] = await readStore(storeOf()).readSource!(id, index, index + 1);
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }

  /** The items from `from` up to, not including, `to`. */
  static async readRange<T = unknown>(id: string, from: number, to: number): Promise<T[]> {
    const rows = await readStore(storeOf()).readSource!(id, from, to);
    return rows.map((row) => JSON.parse(row.payload) as T);
  }

  /** Deletes the source, and resolves to how many items it held. */
  static delete(id: string): Promise<number> {
    return readStore(storeOf()).deleteSource!(id);
  }

  /**
   * Deletes sources written with `ItemSource.write` more than `olderThan`
   * ago, and resolves to how many items. Sources of `step.source` are
   * deleted with their workflow instead.
   */
  static prune(olderThan: Duration): Promise<number> {
    return readStore(storeOf()).pruneSources!(toMilliseconds(olderThan));
  }
}

function storeOf(): WorkflowStore {
  return app(QueueManager).workflows.store;
}

/** The store, once it is known to keep item sources. */
export function readStore(store: WorkflowStore): WorkflowStore {
  if (!store.writeSource || !store.readSource || !store.deleteSource || !store.pruneSources) {
    throw new Error(
      `This queue's workflow store does not keep item sources. The memory and ` +
        `database drivers do.`,
    );
  }
  return store;
}

/** Writes a source: what `ItemSource.write` and `step.source` do. */
export async function writeSource<T>(
  store: WorkflowStore,
  id: string,
  items: ItemSourceInput<T>,
  workflowId: string | null,
): Promise<SourceRef<T>> {
  if (typeof id !== "string" || id.length === 0 || id.length > 191) {
    throw new TypeError(`An item source id is a string of 1 to 191 characters; got ${JSON.stringify(id)}.`);
  }
  readStore(store);
  await store.deleteSource!(id);
  let count = 0;
  let chunk: Array<{ index: number; payload: string }> = [];
  for await (const item of items as AsyncIterable<T>) {
    const payload = JSON.stringify(item === undefined ? null : item);
    if (payload === undefined) {
      throw new TypeError(`Item ${count} of source "${id}" has no JSON form.`);
    }
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > ITEM_SOURCE_ITEM_LIMIT) {
      throw new RangeError(
        `Item ${count} of source "${id}" is ${bytes} bytes as JSON, over the ` +
          `${ITEM_SOURCE_ITEM_LIMIT}-byte limit. Store it elsewhere and keep its id.`,
      );
    }
    chunk.push({ index: count++, payload });
    if (chunk.length >= WRITE_CHUNK) {
      await store.writeSource!(id, workflowId, chunk);
      chunk = [];
    }
  }
  await store.writeSource!(id, workflowId, chunk);
  return { id, count } as SourceRef<T>;
}

/**
 * Reads a source for `step.each`, a window at a time: the first read of an
 * index loads the window it starts, and each item is handed out once. A
 * second read of an index (a retry) loads that one item again.
 */
export function sourceReader<T>(
  store: WorkflowStore,
  source: SourceRef<T>,
  window: number,
): (index: number) => Promise<T> {
  readStore(store);
  const cache = new Map<number, string>();
  const loading = new Map<string, Promise<void>>();
  let loadedUpTo = 0;
  const load = (from: number, to: number) => {
    const key = `${from}:${to}`;
    let pending = loading.get(key);
    if (!pending) {
      pending = store.readSource!(source.id, from, to).then(
        (rows) => {
          for (const row of rows) cache.set(row.index, row.payload);
          loading.delete(key);
        },
        (error: unknown) => {
          loading.delete(key);
          throw error;
        },
      );
      loading.set(key, pending);
    }
    return pending;
  };
  return async (index) => {
    if (!cache.has(index)) {
      const from = index - (index % window);
      const to = Math.min(from + window, source.count);
      if (loading.has(`${from}:${to}`)) {
        await loading.get(`${from}:${to}`);
      } else if (index >= loadedUpTo) {
        loadedUpTo = Math.max(loadedUpTo, to);
        await load(from, to);
      }
      // Read before (a retry), or by a window that has been handed out.
      if (!cache.has(index)) await load(index, index + 1);
    }
    const payload = cache.get(index);
    cache.delete(index);
    if (payload === undefined) {
      throw new Error(`Item source "${source.id}" has no item at index ${index}.`);
    }
    return JSON.parse(payload) as T;
  };
}
