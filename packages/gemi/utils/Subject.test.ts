import { describe, expect, test } from "vitest";

import { Subject } from "./Subject";

/**
 * `Subject`'s methods are read as plain functions — `useSyncExternalStore`
 * takes `subject.subscribe` and `subject.getValue` and calls them with no
 * receiver. Two properties follow, and both were broken in a way nothing
 * caught: `useIsNavigationPending` threw `undefined is not an object
 * (evaluating 'this.value')` on first render, and the call sites that had
 * noticed were binding per render, which makes uSES drop and re-create the
 * subscription on every pass.
 */
describe("Subject", () => {
  test("methods work detached from the instance", () => {
    const subject = new Subject(1);
    const { getValue, next, subscribe } = subject;

    expect(getValue()).toBe(1);

    const seen: number[] = [];
    subscribe((value) => seen.push(value));
    next(2);

    expect(getValue()).toBe(2);
    expect(seen).toEqual([2]);
  });

  test("method identity is stable, so a subscription is not churned", () => {
    const subject = new Subject(1);

    expect(subject.subscribe).toBe(subject.subscribe);
    expect(subject.getValue).toBe(subject.getValue);
  });

  test("each instance keeps its own binding", () => {
    const a = new Subject("a");
    const b = new Subject("b");

    expect(a.getValue()).toBe("a");
    expect(b.getValue()).toBe("b");
    expect(a.subscribe).not.toBe(b.subscribe);
  });
});
