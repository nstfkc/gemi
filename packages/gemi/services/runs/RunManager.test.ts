import { afterEach, describe, expect, test, vi } from "vitest";

import { ChangeFeedManager } from "../change-feed/ChangeFeedManager";
import { RunFailure, RunManager, RunNotFoundError } from "./RunManager";
import { MemoryRunStore, type RunRecord } from "./RunStore";

const managers: RunManager[] = [];
const feeds: ChangeFeedManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const feed of feeds.splice(0)) await feed.close();
  vi.restoreAllMocks();
});

function runs(feed?: ChangeFeedManager) {
  const manager = new RunManager({}, feed ? { feed } : {});
  managers.push(manager);
  return manager;
}

function changeFeed() {
  const feed = new ChangeFeedManager();
  feeds.push(feed);
  return feed;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the record", () => {
  test("create records a pending run with defaults, and get and list find it", async () => {
    const manager = runs();
    const run = await manager.create({ kind: "page-build", subject: "site:1", meta: { page: 2 } });
    expect(run).toMatchObject({
      kind: "page-build",
      subject: "site:1",
      owner: null,
      status: "pending",
      meta: { page: 2 },
      progress: null,
      result: null,
      error: null,
      version: 1,
      startedAt: null,
      finishedAt: null,
      deadlineAt: null,
    });
    expect(run.id).toMatch(/^run_[0-9a-f]{32}$/);
    expect(await manager.get(run.id)).toEqual(run);
    expect(await manager.get("run_missing")).toBeNull();

    const other = await manager.create({ kind: "site-import", subject: "site:1", start: true });
    expect(other.status).toBe("running");
    expect(other.startedAt).toBe(other.createdAt);
    expect((await manager.list({ subject: "site:1" })).map((r) => r.id)).toEqual([
      other.id,
      run.id,
    ]);
    expect((await manager.list({ kind: "page-build" })).map((r) => r.id)).toEqual([run.id]);
    expect((await manager.list({ statuses: ["running"] })).map((r) => r.id)).toEqual([other.id]);
    expect(await manager.list({ subject: "site:1", limit: 1 })).toHaveLength(1);
  });

  test("an id may be given, and is refused when taken", async () => {
    const manager = runs();
    await manager.create({ kind: "k", id: "build-7" });
    await expect(manager.create({ kind: "k", id: "build-7" })).rejects.toThrow(/already exists/);
    await expect(manager.create({ kind: "" })).rejects.toThrow(TypeError);
  });

  test("a deadline is set from now", async () => {
    const manager = runs();
    const run = await manager.create({ kind: "k", deadline: "10m" });
    expect(run.deadlineAt).toBe(run.createdAt + 600_000);
  });
});

describe("transitions", () => {
  test("pending → running → completed, each a new version, and an ended run never changes", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });

    const started = await manager.start(id);
    expect(started).toMatchObject({ status: "running", version: 2 });
    expect(started!.startedAt).not.toBeNull();
    expect(await manager.start(id)).toBeNull();

    const progressed = await manager.progress(id, { fraction: 0.5, message: "Half way" });
    expect(progressed).toMatchObject({
      status: "running",
      version: 3,
      progress: { fraction: 0.5, message: "Half way" },
    });

    const completed = await manager.complete(id, { pageId: 4 });
    expect(completed).toMatchObject({ status: "completed", result: { pageId: 4 }, version: 4 });
    expect(completed!.finishedAt).not.toBeNull();

    expect(await manager.fail(id, "late")).toBeNull();
    expect(await manager.cancel(id)).toBeNull();
    expect(await manager.progress(id, { fraction: 1 })).toBeNull();
    expect((await manager.get(id))!.status).toBe("completed");
  });

  test("progress on a pending run starts it", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    const run = await manager.progress(id, { data: { step: "copy" } });
    expect(run).toMatchObject({ status: "running", progress: { data: { step: "copy" } } });
    expect(run!.startedAt).not.toBeNull();
  });

  test("a progress fraction outside 0..1 is refused", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    await expect(manager.progress(id, { fraction: 1.5 })).rejects.toThrow(RangeError);
  });

  test("fail and cancel record their error", async () => {
    const manager = runs();
    const a = await manager.create({ kind: "k" });
    expect(await manager.fail(a.id, new Error("Boom"))).toMatchObject({
      status: "failed",
      error: { message: "Boom" },
    });
    const b = await manager.create({ kind: "k" });
    expect(await manager.fail(b.id, { message: "Gone", code: "not_found" })).toMatchObject({
      error: { message: "Gone", code: "not_found" },
    });
    const c = await manager.create({ kind: "k" });
    const cancelled = await manager.cancel(c.id, "Stopped by the user.");
    expect(cancelled).toMatchObject({
      status: "cancelled",
      error: { message: "Stopped by the user.", code: "cancelled" },
    });
    // Cancelled before it ever ran: started and finished at once.
    expect(cancelled!.startedAt).toBe(cancelled!.finishedAt);
  });

  test("every change is published to the run's channel", async () => {
    const feed = changeFeed();
    const manager = runs(feed);
    const { id } = await manager.create({ kind: "k" });
    expect(manager.channel(id)).toBe(`gemi:run:${id}`);
    await manager.start(id);
    await manager.complete(id, 1);
    expect(await feed.head(manager.channel(id))).toBe(3);
    const events = [];
    for await (const event of feed.subscribe(manager.channel(id), { cursor: { [manager.channel(id)]: 0 } })) {
      events.push(event);
      if (events.length === 3) break;
    }
    expect(events.map((e) => (e.type === "change" ? (e.data as RunRecord).status : e.type))).toEqual([
      "pending",
      "running",
      "completed",
    ]);
  });

  test("a failed publish is logged, and the change stands", async () => {
    const feed = changeFeed();
    vi.spyOn(feed, "publish").mockRejectedValue(new Error("feed down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = runs(feed);
    const run = await manager.create({ kind: "k" });
    expect(await manager.complete(run.id)).toMatchObject({ status: "completed" });
    expect(log).toHaveBeenCalled();
  });
});

describe("wait", () => {
  test("resolves once the run ends, woken by the feed", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    const waiting = manager.wait(id);
    await sleep(5);
    await manager.progress(id, { fraction: 0.2 });
    await sleep(5);
    await manager.complete(id, "done");
    const run = await waiting;
    expect(run).toMatchObject({ status: "completed", result: "done" });
  });

  test("resolves at once for a run that ended", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    await manager.fail(id, "no");
    expect(await manager.wait(id)).toMatchObject({ status: "failed" });
  });

  test("with a timeout, resolves to the open run when it passes", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    const started = Date.now();
    const run = await manager.wait(id, { timeout: 30 });
    expect(run.status).toBe("pending");
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  test("times out a run past its deadline", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k", deadline: 20 });
    const run = await manager.wait(id);
    expect(run).toMatchObject({
      status: "timed_out",
      error: { message: "The run passed its deadline.", code: "deadline" },
    });
  });

  test("rejects with the signal's reason when it aborts, and for an unknown run", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    const controller = new AbortController();
    const waiting = manager.wait(id, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("gave up")), 5);
    await expect(waiting).rejects.toThrow("gave up");
    await expect(manager.wait("run_nope")).rejects.toBeInstanceOf(RunNotFoundError);
    expect(manager.feed.subscriptions).toBe(0);
  });
});

describe("subscribe", () => {
  test("yields the run now, then each version, and ends with the one that ended it", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    const seen: string[] = [];
    const following = (async () => {
      for await (const run of manager.subscribe(id)) seen.push(`${run.status}@${run.version}`);
    })();
    await sleep(5);
    await manager.progress(id, { fraction: 0.1 });
    await sleep(5);
    await manager.complete(id);
    await following;
    expect(seen).toEqual(["pending@1", "running@2", "completed@3"]);
    expect(manager.feed.subscriptions).toBe(0);
  });
});

describe("execute", () => {
  test("starts the run, reports progress, and completes it with what fn returns", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    const run = await manager.execute(id, async (handle) => {
      expect(handle.record.status).toBe("running");
      await handle.progress({ fraction: 0.5 });
      return { pageId: 9 };
    });
    expect(run).toMatchObject({
      status: "completed",
      result: { pageId: 9 },
      progress: { fraction: 0.5 },
    });
    expect(manager.feed.subscriptions).toBe(0);
  });

  test("a RunFailure fails the run with its message and code; anything else with a generic one", async () => {
    const manager = runs();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await manager.create({ kind: "k" });
    const failed = await manager.execute(a.id, () => {
      throw new RunFailure("The Figma file is gone.", { code: "not_found" });
    });
    expect(failed).toMatchObject({
      status: "failed",
      error: { message: "The Figma file is gone.", code: "not_found" },
    });
    expect(log).not.toHaveBeenCalled();

    const b = await manager.create({ kind: "k" });
    const crashed = await manager.execute(b.id, async () => {
      throw new Error("ECONNREFUSED 10.0.0.3:5432");
    });
    expect(crashed).toMatchObject({
      status: "failed",
      error: { message: "The run failed.", code: "error" },
    });
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a cancel aborts the signal, and the run stays cancelled", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    let aborted = false;
    const executing = manager.execute(id, async (run) => {
      await new Promise<void>((resolve) => {
        run.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      return "too late";
    });
    await sleep(10);
    await manager.cancel(id);
    const run = await executing;
    expect(aborted).toBe(true);
    expect(run.status).toBe("cancelled");
  });

  test("the deadline aborts the signal and times the run out", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k", deadline: 20 });
    const run = await manager.execute(id, async (handle) => {
      await new Promise((resolve) => handle.signal.addEventListener("abort", resolve));
      throw new Error("aborted");
    });
    expect(run.status).toBe("timed_out");
  });

  test("does not call fn for a run that ended, and rejects for an unknown one", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k" });
    await manager.cancel(id);
    const fn = vi.fn();
    expect(await manager.execute(id, fn)).toMatchObject({ status: "cancelled" });
    expect(fn).not.toHaveBeenCalled();
    await expect(manager.execute("run_nope", fn)).rejects.toBeInstanceOf(RunNotFoundError);
    expect(manager.feed.subscriptions).toBe(0);
  });

  test("takes up a run that is already running (a retried job)", async () => {
    const manager = runs();
    const { id } = await manager.create({ kind: "k", start: true });
    expect(await manager.execute(id, () => 1)).toMatchObject({ status: "completed", result: 1 });
  });
});

describe("housekeeping", () => {
  test("sweep times out open runs past their deadline, and only those", async () => {
    const manager = runs();
    const late = await manager.create({ kind: "k", deadline: 1 });
    const fine = await manager.create({ kind: "k", deadline: "1h" });
    const none = await manager.create({ kind: "k" });
    const ended = await manager.create({ kind: "k", deadline: 1 });
    await manager.complete(ended.id);
    await sleep(5);
    expect(await manager.sweep()).toBe(1);
    expect((await manager.get(late.id))!.status).toBe("timed_out");
    expect((await manager.get(fine.id))!.status).toBe("pending");
    expect((await manager.get(none.id))!.status).toBe("pending");
    expect((await manager.get(ended.id))!.status).toBe("completed");
  });

  test("prune deletes runs that ended long enough ago", async () => {
    const store = new MemoryRunStore();
    const manager = new RunManager({ store });
    managers.push(manager);
    const ended = await manager.create({ kind: "k" });
    await manager.complete(ended.id);
    await manager.create({ kind: "k" });
    expect(await manager.prune("1h")).toBe(0);
    await sleep(5);
    expect(await manager.prune(1)).toBe(1);
    expect(store.size).toBe(1);
  });

  test("an unknown store name is refused", () => {
    expect(() => new RunManager({ store: "redis" as never })).toThrow(/Unknown runs store/);
    expect(() => new RunManager({ store: "database" })).toThrow(/application/);
  });
});
