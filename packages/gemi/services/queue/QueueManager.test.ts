import { afterEach, describe, expect, test, vi } from "vitest";

import { Job } from "./Job";
import type { MemoryQueueDriver } from "./MemoryQueueDriver";
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
 * The worker loop claims from its driver, so a job runs a few microtasks after
 * `push()` rather than inside it; `settle()` waits those out. A loop that
 * recursed on an unresolvable entry used to take the test process down with
 * it rather than time out politely, which is why these assert on the driver
 * being empty and not only on the error line.
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const memory = (queue: QueueManager) => queue.driver as MemoryQueueDriver;

describe("a dispatch nothing is registered under", () => {
  test("is dropped, said out loud, and does not wedge the queue", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new QueueManager({ jobs: [] });

    await queue.push(SendWelcomeEmail, "[]");
    await settle();

    // Drained, not left at the head. It used to stay: the delete lived inside
    // the branch that resolved the name, so the queue never emptied and the
    // drain recursed on the same entry until the stack gave out — a stack
    // overflow in place of the dropped job the docs describe. Now the claim is
    // ended as a dead letter, so nothing is waiting and nothing is leased.
    expect(memory(queue).waiting).toBe(0);
    expect(memory(queue).leased).toBe(0);
    expect(queue.running).toBe(0);
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      'nothing is registered under the name "SendWelcomeEmail"',
    );
  });

  test("does not stop the jobs behind it in the queue from running", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new QueueManager({ jobs: [ChargeCard], concurrency: 5 });
    const ran = vi.spyOn(ChargeCard.prototype, "run");

    queue.push(SendWelcomeEmail, "[]");
    queue.push(ChargeCard, "[]");
    await settle();

    expect(ran).toHaveBeenCalledTimes(1);
    expect(memory(queue).waiting).toBe(0);
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

/**
 * Adding one job to a registry that is already full.
 *
 * `useJobs` cannot do this — it replaces the registry — and the events provider
 * needs it, because a queued listener is registered as a job after the queue's
 * own `boot()` has run. The failure being guarded is the one `useJobs` would
 * have had: an app's own jobs quietly gone, in a process that boots cleanly and
 * drops every dispatch afterwards.
 */
describe("registerJob", () => {
  test("adds to the registry without disturbing what is already in it", () => {
    const queue = new QueueManager({ jobs: [ChargeCard] });

    queue.registerJob(SendWelcomeEmail);

    expect(queue.dispatchJob("ChargeCard", "[]")).toBe("charged");
    expect(queue.dispatchJob("SendWelcomeEmail", "[]")).toBe("sent");
    expect(queue.registeredJobs).toHaveLength(2);
  });

  test("refuses a name that is taken, and keeps the job that took it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new QueueManager({ jobs: [ChargeCard] });

    const impostor = {
      ChargeCard: class ChargeCard extends Job {
        run() {
          return "impostor";
        }
      },
    }.ChargeCard;

    queue.registerJob(impostor);

    expect(queue.dispatchJob("ChargeCard", "[]")).toBe("charged");
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      'Two queued jobs are named "ChargeCard"',
    );
    // Reported anyway, the same as a duplicate handed to `useJobs`: the getter
    // says what the manager was given, so a test can see the clash.
    expect(queue.registeredJobs).toHaveLength(2);
  });

  test("does not edit the array `useJobs` was handed", () => {
    const declared = [ChargeCard];
    const queue = new QueueManager({ jobs: declared });

    queue.registerJob(SendWelcomeEmail);

    expect(declared).toEqual([ChargeCard]);
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
  test("runs, and leaves the queue empty", async () => {
    const queue = new QueueManager({ jobs: [ChargeCard] });
    const ran = vi.spyOn(ChargeCard.prototype, "run");

    queue.push(ChargeCard, "[]");
    await settle();

    expect(ran).toHaveBeenCalledTimes(1);
    expect(memory(queue).waiting).toBe(0);
    expect(memory(queue).leased).toBe(0);
  });
});
