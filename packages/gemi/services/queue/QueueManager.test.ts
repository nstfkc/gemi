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

/**
 * Two classes with one name.
 *
 * A directory walk is what makes this ordinary: `auth/SendEmail.ts` beside
 * `billing/SendEmail.ts` is a natural thing to write, and nothing forces the
 * import alias that a hand-written list would have demanded. The failure is
 * also the worst one here — not a dropped dispatch but the wrong body running
 * under the right name, reporting success.
 */
describe("two jobs claiming one class name", () => {
  /** Same class name, different bodies — what two directories would produce. */
  const sendEmail = (from: string) =>
    ({
      SendEmail: class SendEmail extends Job {
        run() {
          return from;
        }
      },
    }).SendEmail;

  test("the first keeps the name, the second is refused out loud", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = sendEmail("auth");
    const billing = sendEmail("billing");

    const queue = new QueueManager({ jobs: [auth, billing] });

    // The registry resolves to the first. It used to resolve to the last —
    // `Object.fromEntries` keeps the final occurrence of a repeated key — so
    // dispatching the auth class ran billing's body and said nothing.
    expect(queue.dispatchJob("SendEmail", "[]")).toBe("auth");
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      'Two queued jobs are named "SendEmail"',
    );
  });

  test("both still appear in `registeredJobs`, so a test can see the clash", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const queue = new QueueManager({
      jobs: [sendEmail("auth"), sendEmail("billing")],
    });

    expect(queue.registeredJobs).toHaveLength(2);
  });
});

describe("the readable view", () => {
  test("is a copy, so walking it cannot edit what the queue runs from", () => {
    const queue = new QueueManager({ jobs: [ChargeCard] });

    (queue.registeredJobs as Array<new () => Job>).length = 0;

    expect(queue.registeredJobs).toHaveLength(1);
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
