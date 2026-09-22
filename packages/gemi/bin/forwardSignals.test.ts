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
  for (const signal of ["SIGTERM", "SIGINT"]) {
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

// The server's side, through the real `installShutdownSignals`: it prints each
// shutdown it starts and exits 0 once that one finishes, so a copy of the
// signal read as "exit now" shows as a 130 with no "drained".
const server = join(dir, "server.ts");
writeFileSync(
  server,
  `
  import { installShutdownSignals } from ${JSON.stringify(join(import.meta.dirname, "../server/shutdown.ts"))};
  installShutdownSignals(async () => {
    console.log("draining");
    await Bun.sleep(300);
    console.log("drained");
    return 0;
  });
  console.log("child ready");
  setInterval(() => {}, 1000);
`,
);
writeFileSync(
  join(dir, "server-parent.ts"),
  `
  import { spawnForwardingSignals } from ${JSON.stringify(join(import.meta.dirname, "forwardSignals.ts"))};
  process.exit(await spawnForwardingSignals({ cmd: ["bun", ${JSON.stringify(server)}] }));
`,
);
// `bun run start`, the shape the docs recommend. `bun run` forwards a signal to
// its script as well, so one Ctrl+C reaches the server three times.
writeFileSync(
  join(dir, "package.json"),
  JSON.stringify({ name: "forward-signals-test", scripts: { start: "bun server-parent.ts" } }),
);

async function run(send: (pid: number) => void, cmd = ["bun", parent]) {
  const proc = Bun.spawn({
    cmd,
    cwd: dir,
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
  return {
    code,
    lines: output
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith("[gemi]")),
  };
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

  // The child stays in the parent's group, so a supervisor's group SIGKILL
  // still reaches it. The cost is that a group signal arrives twice.
  test("a signal to the whole process group reaches the child directly too", async () => {
    const { lines } = await run((pid) => process.kill(-pid, "SIGINT"));

    expect(lines.filter((line) => line.startsWith("child got"))).toEqual([
      "child got SIGINT",
      "child got SIGINT",
    ]);
  });

  // Every copy of one Ctrl+C or one systemd stop lands within milliseconds,
  // and none of them may read as the "exit now" second signal.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`a group ${signal} through \`bun run start\` drains once and exits 0`, async () => {
      const { code, lines } = await run(
        (pid) => process.kill(-pid, signal),
        ["bun", "run", "start"],
      );

      expect(lines).toEqual(["child ready", "draining", "drained"]);
      expect(code).toBe(0);
    });
  }
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
