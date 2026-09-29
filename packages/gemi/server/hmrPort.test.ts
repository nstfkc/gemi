import { describe, expect, test } from "vitest";

import { resolveHmrPort } from "./hmrPort";

// A prober that reports every port free — the "nothing else is running" case.
const allFree = () => true;

// A prober that reports the listed ports taken.
const taken = (...ports: number[]) => {
  const busy = new Set(ports);
  return (port: number) => !busy.has(port);
};

describe("resolveHmrPort", () => {
  test("the default HTTP port keeps Vite's default HMR port", () => {
    // Not an arbitrary choice: a single dev server has to behave exactly as it
    // did before this existed, or every README, firewall rule and container
    // port mapping that names 24678 breaks for the people who never had the bug.
    expect(resolveHmrPort(5173, allFree)).toBe(24678);
  });

  test("two dev servers on different ports get different HMR ports", () => {
    // The whole point. `PORT=5174 bun dev` alongside a default one used to mean
    // both binding 24678.
    expect(resolveHmrPort(5174, allFree)).toBe(24679);
    expect(resolveHmrPort(5173, allFree)).not.toBe(resolveHmrPort(5174, allFree));
  });

  test("distinct HTTP ports stay distinct for any spread of ports", () => {
    const httpPorts = [3000, 4000, 5173, 5174, 5175, 8080, 9229];
    const hmrPorts = httpPorts.map((port) => resolveHmrPort(port, allFree));
    expect(new Set(hmrPorts).size).toBe(httpPorts.length);
  });

  test("an HTTP port below the default derives a lower HMR port", () => {
    expect(resolveHmrPort(3000, allFree)).toBe(24678 - (5173 - 3000));
  });

  test("walks up when the derived port is taken", () => {
    // By something that is not a gemi dev server — another server's derived
    // port cannot land here, but an unrelated process's can.
    expect(resolveHmrPort(5173, taken(24678))).toBe(24679);
    expect(resolveHmrPort(5173, taken(24678, 24679, 24680))).toBe(24681);
  });

  test("falls back to the default when the derived port would overflow the range", () => {
    // `PORT=60000` derives 79505, which is not a port. Rather than clamping to
    // 65535 — where it would collide with every other out-of-range server, the
    // one thing the derivation exists to prevent — it starts from the default
    // and scans.
    expect(resolveHmrPort(60000, allFree)).toBe(24678);
    // And just below the top, where the derived port is legal but the walk
    // would run off the end of the range.
    expect(resolveHmrPort(46000, allFree)).toBe(24678);
    // The port either side of that boundary still derives normally.
    expect(resolveHmrPort(45900, allFree)).toBe(65405);
  });

  test("never returns a port outside the usable range", () => {
    for (const httpPort of [0, 1, 80, 1024, 5173, 40000, 60000, 65535]) {
      const port = resolveHmrPort(httpPort, allFree);
      expect(port).toBeGreaterThan(1023);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });

  test("gives up with an actionable error rather than hanging or returning a busy port", () => {
    expect(() => resolveHmrPort(5173, () => false)).toThrow(
      /Could not find a free port .* 24678-24741/,
    );
    // The message has to name the escape hatch, because the only thing the
    // person running `gemi dev` can do about it is set the port themselves.
    expect(() => resolveHmrPort(5173, () => false)).toThrow(/gemi\.config\.ts.*server.*ws.*port/);
  });

  test("skips a port that is really bound, using the real prober", () => {
    // Every other test here injects `isFree`, which leaves the bind test itself
    // — the part that talks to the OS, and the part that has to agree with how
    // Vite binds — covered by nothing. 15173 derives 34678.
    const held = Bun.listen({
      hostname: "0.0.0.0",
      port: 34678,
      socket: { data() {} },
    });
    try {
      expect(resolveHmrPort(15173)).not.toBe(34678);
    } finally {
      held.stop(true);
    }

    // And releasing it makes the derived port available again, so the skip was
    // the bind test reacting to the socket rather than the port being unusable.
    expect(resolveHmrPort(15173)).toBe(34678);
  });

  test("probes each port at most once, in ascending order", () => {
    // Guards against a scan that retries the same port or walks downward into
    // the previous server's territory.
    const probed: number[] = [];
    resolveHmrPort(5173, (port) => {
      probed.push(port);
      return port === 24681;
    });
    expect(probed).toEqual([24678, 24679, 24680, 24681]);
  });
});
