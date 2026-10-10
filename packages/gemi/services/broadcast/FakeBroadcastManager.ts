import type { Application } from "../../foundation/Application";
import { BroadcastManager } from "./BroadcastManager";
import { parsePattern, topicMatches } from "./channels";
import type { BroadcastRevocation } from "./BroadcastDriver";
import type { SentBroadcast } from "./types";

/**
 * What `Broadcast.fake()` installs: a `BroadcastManager` that records every
 * emit instead of handing it to a driver.
 *
 * Everything before the hand-off is the real manager's: channels and params
 * are checked, payloads encoded and size-checked, and inside an ORM
 * transaction an emit is recorded only once the transaction commits (and
 * never if it rolls back). So a test sees what clients would have been sent.
 *
 * `restore()` is not optional, for the reason it is not on `Event.fake()`.
 */
export class FakeBroadcastManager extends BroadcastManager {
  readonly sent: SentBroadcast[] = [];
  /** Every `Broadcast.revoke`, as it would travel: `{ user }` or `{ topic }`. */
  readonly revoked: BroadcastRevocation[] = [];

  static install(application: Application): FakeBroadcastManager {
    // Built if it was not yet: the fake takes its limits and the app's
    // channels from it, and `restore()` puts it back.
    const current = application.bound(BroadcastManager)
      ? application.make(BroadcastManager)
      : undefined;
    if (current instanceof FakeBroadcastManager) return current;

    const fake = new FakeBroadcastManager(application, current);
    application.instance(BroadcastManager, fake);
    return fake;
  }

  private constructor(
    private readonly application: Application,
    private readonly previous: BroadcastManager | undefined,
  ) {
    super(
      {
        driver: "memory",
        maxEventBytes: previous?.config.maxEventBytes,
        warnEventBytes: previous?.config.warnEventBytes,
      },
      { application },
    );
    // The app's channels stay reachable, so a subscription authorized while
    // the fake is installed is decided by the real router.
    this.channelsFrom = previous;
  }

  private readonly channelsFrom: BroadcastManager | undefined;

  override get channels() {
    return this.channelsFrom?.channels ?? null;
  }

  protected override publish(sent: SentBroadcast): void {
    this.sent.push(sent);
  }

  protected override sendRevocation(revocation: BroadcastRevocation): void {
    this.revoked.push(revocation);
  }

  /** Puts the real manager back. */
  restore(): void {
    if (this.previous) {
      this.application.instance(BroadcastManager, this.previous);
      return;
    }
    this.application.forget(BroadcastManager);
  }

  /**
   * Asserts something was sent to `channel`: a pattern (`"site.:siteId"`,
   * matching every topic it builds), a concrete topic (`"site.abc123"`), or
   * `"user"` (every `user.<id>`). `event` and `predicate` narrow it.
   */
  assertSent(
    channel: string,
    event?: string,
    predicate?: (data: any, sent: SentBroadcast) => boolean,
  ): void {
    if (this.matching(channel, event, predicate).length > 0) return;
    throw new Error(
      `Expected ${describeQuery(channel, event, predicate)} to have been ` +
        `broadcast. ${this.summary()}`,
    );
  }

  /** Asserts nothing matching was sent. Same arguments as `assertSent`. */
  assertNotSent(
    channel: string,
    event?: string,
    predicate?: (data: any, sent: SentBroadcast) => boolean,
  ): void {
    const matches = this.matching(channel, event, predicate);
    if (matches.length === 0) return;
    throw new Error(
      `Expected ${describeQuery(channel, event, predicate)} not to have been ` +
        `broadcast, but it was broadcast ${count(matches.length)}: ${describeAll(matches)}.`,
    );
  }

  /** Asserts exactly `times` matching emits. */
  assertSentTimes(
    channel: string,
    times: number,
    event?: string,
    predicate?: (data: any, sent: SentBroadcast) => boolean,
  ): void {
    const matches = this.matching(channel, event, predicate);
    if (matches.length === times) return;
    throw new Error(
      `Expected ${describeQuery(channel, event, predicate)} to have been ` +
        `broadcast ${count(times)}, but it was broadcast ${count(matches.length)}. ` +
        this.summary(),
    );
  }

  /** Asserts nothing at all was broadcast. */
  assertNothingSent(): void {
    if (this.sent.length === 0) return;
    throw new Error(
      `Expected nothing to have been broadcast, but ${this.sent.length} ` +
        `${this.sent.length === 1 ? "emit was" : "emits were"}: ${describeAll(this.sent)}.`,
    );
  }

  private matching(
    channel: string,
    event: string | undefined,
    predicate: ((data: any, sent: SentBroadcast) => boolean) | undefined,
  ): SentBroadcast[] {
    // A malformed channel throws rather than matching nothing, so a typo in
    // assertNotSent or assertSentTimes(..., 0) cannot pass vacuously.
    parsePattern(channel);
    return this.sent.filter(
      (sent) =>
        (sent.pattern === channel || topicMatches(channel, sent.topic)) &&
        (event === undefined || sent.event === event) &&
        (predicate === undefined || predicate(sent.data, sent)),
    );
  }

  private summary(): string {
    if (this.sent.length === 0) return "Nothing was broadcast.";
    return `Broadcast: ${describeAll(this.sent)}.`;
  }
}

function describeQuery(channel: string, event: string | undefined, predicate: unknown) {
  return (
    `${event ? `"${event}" on ` : "an event on "}"${channel}"` +
    (predicate ? " matching the predicate" : "")
  );
}

function count(times: number): string {
  return `${times} ${times === 1 ? "time" : "times"}`;
}

function describeAll(sent: SentBroadcast[]): string {
  return sent.map((s) => `${s.topic} ${s.event}(${inspect(s.data)})`).join(", ");
}

function inspect(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
