import { afterEach, describe, expect, test, vi } from "vitest";

import { Job } from "./Job";
import { QueueManager } from "./QueueManager";

/**
 * What happens to a dispatch the registry cannot resolve.
 *
 * This is the exact failure #322 is about, seen from the far end: the job class
 * exists, the dispatch happened, and the name it carried matches nothing the
 * manager holds. Discovery is what makes that state ordinary rather than
 * exotic — an app no longer writes the registry by hand, so "nothing is
 * registered" is now reachable by shipping a build without its source, and the
 * queue has to survive it.
 *
 * `next()` runs to completion synchronously on this path — nothing before the
 * unknown name is awaited — so `push()` is enough to drive it, and a
 * non-terminating one takes the test process down with it rather than timing
 * out politely.
 */

class SendWelcomeEmail extends Job {
  run() {
    return "sent";
  }
}

class ChargeCard extends Job {
  run() {
    return "charged";
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a dispatch nothing is registered under", () => {
  test("is dropped, said out loud, and does not wedge the queue", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new QueueManager({ jobs: [] });

    queue.push(SendWelcomeEmail, "[]");

    // Drained, not left at the head. It used to stay: the delete lived inside
    // the branch that resolved the name, so the queue never emptied, the
    // `size === 0` return was never reached, and `next()` recursed on the same
    // entry until the stack gave out — a stack overflow in place of the
    // dropped job the docs describe.
    expect(queue.queue.size).toBe(0);
    expect(queue.isRunning).toBe(false);
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      'nothing is registered under the name "SendWelcomeEmail"',
    );
  });

  test("does not stop the jobs behind it in the queue from running", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new QueueManager({ jobs: [ChargeCard], concurrency: 5 });
    const ran = vi.spyOn(ChargeCard.prototype, "run");

    queue.push(SendWelcomeEmail, "[]");
    queue.push(ChargeCard, "[]");

    expect(ran).toHaveBeenCalledTimes(1);
    expect(queue.queue.size).toBe(0);
  });
});

describe("a dispatch that resolves", () => {
  test("runs, and leaves the queue empty", () => {
    const queue = new QueueManager({ jobs: [ChargeCard] });
    const ran = vi.spyOn(ChargeCard.prototype, "run");

    queue.push(ChargeCard, "[]");

    expect(ran).toHaveBeenCalledTimes(1);
    expect(queue.queue.size).toBe(0);
  });
});
