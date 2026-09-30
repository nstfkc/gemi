import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DevGeneration, replaceDevGeneration, resetDevGeneration } from "./devReload";
import type { Instrumentation } from "./types";

const passThrough: Instrumentation = (req, next) => next(req);
const fast = { graceMs: 1_000, providerTimeoutMs: 1_000 };

function fakeApp(shutdown: () => unknown = () => {}) {
  return { shutdown: vi.fn(async (_options?: { timeoutMs?: number }) => shutdown()) };
}

/** A request held open on `generation` until `release()` is called. */
function holdRequest(generation: DevGeneration) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const response = generation.track(passThrough)(new Request("http://app/"), async () => {
    await held;
    return new Response("ok");
  });
  return { response, release };
}

beforeEach(() => {
  resetDevGeneration();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetDevGeneration();
  vi.restoreAllMocks();
});

describe("replaceDevGeneration", () => {
  test("the first application replaces nothing", async () => {
    const first = fakeApp();

    await replaceDevGeneration(new DevGeneration(first), fast);

    expect(first.shutdown).not.toHaveBeenCalled();
  });

  test("a reload shuts the previous application down, and only that one, once", async () => {
    const first = fakeApp();
    const second = fakeApp();
    const third = fakeApp();

    await replaceDevGeneration(new DevGeneration(first), fast);
    await replaceDevGeneration(new DevGeneration(second), fast);

    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(first.shutdown).toHaveBeenCalledWith({ timeoutMs: 1_000 });
    expect(second.shutdown).not.toHaveBeenCalled();

    await replaceDevGeneration(new DevGeneration(third), fast);

    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(second.shutdown).toHaveBeenCalledTimes(1);
    expect(third.shutdown).not.toHaveBeenCalled();
  });

  test("waits for the previous application's requests before shutting it down", async () => {
    const first = fakeApp();
    const previous = new DevGeneration(first);
    await replaceDevGeneration(previous, fast);
    const request = holdRequest(previous);
    expect(previous.pending).toBe(1);

    const retiring = replaceDevGeneration(new DevGeneration(fakeApp()), {
      graceMs: 5_000,
      providerTimeoutMs: 1_000,
    });
    await Bun.sleep(50);
    expect(first.shutdown).not.toHaveBeenCalled();

    request.release();
    expect(await (await request.response).text()).toBe("ok");
    await retiring;
    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(previous.pending).toBe(0);
  });

  test("does not wait past the grace period for a request that never ends", async () => {
    const first = fakeApp();
    const previous = new DevGeneration(first);
    await replaceDevGeneration(previous, fast);
    holdRequest(previous);

    const started = Date.now();
    await replaceDevGeneration(new DevGeneration(fakeApp()), {
      graceMs: 100,
      providerTimeoutMs: 1_000,
    });

    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("returns before the retirement finishes, so the reload is not held up", async () => {
    let finish!: () => void;
    const first = fakeApp(() => new Promise<void>((resolve) => (finish = resolve)));
    await replaceDevGeneration(new DevGeneration(first), fast);

    let settled = false;
    const retiring = replaceDevGeneration(new DevGeneration(fakeApp()), fast).then(
      () => (settled = true),
    );
    await Bun.sleep(20);

    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finish();
    await retiring;
    expect(settled).toBe(true);
  });

  test("a shutdown that throws or rejects is logged, not raised", async () => {
    const throws = fakeApp(() => {
      throw new Error("sync boom");
    });
    const rejects = { shutdown: vi.fn(() => Promise.reject(new Error("async boom"))) };

    await replaceDevGeneration(new DevGeneration(throws), fast);
    await expect(replaceDevGeneration(new DevGeneration(rejects), fast)).resolves.toBeUndefined();
    await expect(replaceDevGeneration(new DevGeneration(fakeApp()), fast)).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(console.error).mock.calls[0][1])).toContain("sync boom");
    expect(String(vi.mocked(console.error).mock.calls[1][1])).toContain("async boom");
  });

  // What a reload reads back is the previous module graph's object, so its
  // shape is not something this graph's types can promise.
  test("a previous entry of another shape is replaced without being called", async () => {
    (globalThis as any)[Symbol.for("gemi.server.devGeneration")] = { something: "else" };
    const next = new DevGeneration(fakeApp());

    await expect(replaceDevGeneration(next, fast)).resolves.toBeUndefined();

    const after = fakeApp();
    await replaceDevGeneration(new DevGeneration(after), fast);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("a request that throws is still counted out", async () => {
    const generation = new DevGeneration(fakeApp());
    const failing = generation.track(passThrough)(new Request("http://app/"), async () => {
      throw new Error("controller failed");
    });

    await expect(failing).rejects.toThrow("controller failed");
    expect(generation.pending).toBe(0);
  });
});
