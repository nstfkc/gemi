import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { exitCodeOf } from "./forwardSignals";

// `gemi start` itself can't be spawned here — it runs a built server — so the
// relay is exercised the way `start` uses it: a parent script that hands a
// child to `spawnForwardingSignals` and exits with what it returns. The child
// prints each signal it receives and exits 7 a moment after the first, so a
// parent that stopped waiting for it, or dropped its code, shows.
const dir = mkdtempSync(join(tmpdir(), "gemi-forward-signals-"));
const child = join(dir, "child.ts");
const parent = join(dir, "parent.ts");

writeFileSync(
  child,
  `
  let first = true;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      console.log("child got " + signal);
      if (first) setTimeout(() => process.exit(7), 300);
      first = false;
    });
  }
  console.log("child ready");
  setInterval(() => {}, 1000);
`,
);

writeFileSync(
  parent,
  `
  import { spawnForwardingSignals } from ${JSON.stringify(join(import.meta.dirname, "forwardSignals.ts"))};
  const code = await spawnForwardingSignals({ cmd: ["bun", ${JSON.stringify(child)}] });
  console.log("parent exiting " + code);
  process.exit(code);
`,
);

async function run(send: (pid: number) => void) {
  const proc = Bun.spawn({
    cmd: ["bun", parent],
    stdout: "pipe",
    stderr: "inherit",
    // Its own process group, so `-pid` below reaches the parent and anything
    // still in its group — what a terminal's Ctrl+C does to a foreground job.
    detached: true,
  });

  const decoder = new TextDecoder();
  let output = "";
  const reader = proc.stdout.getReader();
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      output += decoder.decode(value);
    }
  })();

  while (!output.includes("child ready")) await Bun.sleep(20);
  send(proc.pid);

  const code = await proc.exited;
  await read;
  return { code, lines: output.trim().split("\n") };
}

describe("spawnForwardingSignals", () => {
  test("relays SIGTERM, waits for the child, and exits with its code", async () => {
    const { code, lines } = await run((pid) => process.kill(pid, "SIGTERM"));

    expect(lines).toEqual(["child ready", "child got SIGTERM", "parent exiting 7"]);
    expect(code).toBe(7);
  });

  test("relays SIGINT as SIGINT", async () => {
    const { code, lines } = await run((pid) => process.kill(pid, "SIGINT"));

    expect(lines).toEqual(["child ready", "child got SIGINT", "parent exiting 7"]);
    expect(code).toBe(7);
  });

  test("relays SIGHUP as SIGTERM, since the server only drains on that", async () => {
    const { code, lines } = await run((pid) => process.kill(pid, "SIGHUP"));

    expect(lines).toEqual(["child ready", "child got SIGTERM", "parent exiting 7"]);
    expect(code).toBe(7);
  });

  // A terminal's Ctrl+C signals the whole foreground group. Were the child in
  // the parent's group it would get this SIGINT twice — directly and through
  // the relay — and the server treats a second signal as "exit now".
  test("a signal to the parent's whole process group reaches the child once", async () => {
    const { lines } = await run((pid) => process.kill(-pid, "SIGINT"));

    expect(lines.filter((line) => line.startsWith("child got"))).toEqual(["child got SIGINT"]);
  });
});

describe("exitCodeOf", () => {
  test("is the exit code when there is one", () => {
    expect(exitCodeOf({ exitCode: 3, signalCode: null })).toBe(3);
    expect(exitCodeOf({ exitCode: 0, signalCode: null })).toBe(0);
  });

  test("is 128 + n for a child a signal ended", () => {
    expect(exitCodeOf({ exitCode: null, signalCode: "SIGKILL" })).toBe(137);
    expect(exitCodeOf({ exitCode: null, signalCode: "SIGTERM" })).toBe(143);
  });
});
