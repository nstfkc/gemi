import { describe, expect, test } from "vitest";

import { MemoryCircuitStore } from "./CircuitStore";

const policy = { failures: 2, cooldownMs: 1_000 };

function store() {
  let now = 0;
  const circuits = new MemoryCircuitStore(() => now);
  return { circuits, advance: (ms: number) => (now += ms) };
}

describe("MemoryCircuitStore", () => {
  test("opens after `failures` in a row and says so once", () => {
    const { circuits } = store();
    expect(circuits.record("a", "failure", policy)).toBeUndefined();
    expect(circuits.allow("a", policy)).toBe(true);
    expect(circuits.record("a", "failure", policy)).toBe("open");
    expect(circuits.allow("a", policy)).toBe(false);
    expect(circuits.state("a")).toBe("open");
    // Other keys are their own.
    expect(circuits.allow("b", policy)).toBe(true);
  });

  test("half-open lets one probe through and holds everyone else back", () => {
    const { circuits, advance } = store();
    circuits.record("a", "failure", policy);
    circuits.record("a", "failure", policy);
    advance(1_000);
    expect(circuits.allow("a", policy)).toBe(true);
    expect(circuits.allow("a", policy)).toBe(false);
    expect(circuits.record("a", "success", policy)).toBe("closed");
    expect(circuits.allow("a", policy)).toBe(true);
    expect(circuits.state("a")).toBe("closed");
  });

  test("a probe that learned nothing frees the slot; one that never reports is given up on", () => {
    const { circuits, advance } = store();
    circuits.record("a", "failure", policy);
    circuits.record("a", "failure", policy);
    advance(1_000);
    expect(circuits.allow("a", policy)).toBe(true);
    circuits.record("a", "none", policy);
    expect(circuits.allow("a", policy)).toBe(true);
    // This probe never reports back.
    expect(circuits.allow("a", policy)).toBe(false);
    advance(999);
    expect(circuits.allow("a", policy)).toBe(false);
    advance(1);
    expect(circuits.allow("a", policy)).toBe(true);
  });

  test("a failed probe reopens for a full cool-down", () => {
    const { circuits, advance } = store();
    circuits.record("a", "failure", policy);
    circuits.record("a", "failure", policy);
    advance(1_000);
    circuits.allow("a", policy);
    expect(circuits.record("a", "failure", policy)).toBeUndefined();
    expect(circuits.state("a")).toBe("open");
    advance(999);
    expect(circuits.allow("a", policy)).toBe(false);
    advance(1);
    expect(circuits.allow("a", policy)).toBe(true);
  });

  test("`none` on a closed key changes nothing and a success resets the count", () => {
    const { circuits } = store();
    circuits.record("a", "failure", policy);
    circuits.record("a", "none", policy);
    circuits.record("a", "success", policy);
    expect(circuits.record("a", "failure", policy)).toBeUndefined();
    expect(circuits.state("a")).toBe("closed");
  });
});
