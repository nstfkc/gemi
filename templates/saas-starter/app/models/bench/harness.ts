import { SQL } from "bun";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The benchmark harness.
 *
 * Deliverable 1 of iteration 7, and ordered first on purpose: the risk in that
 * iteration is optimising the wrong stage. A nested `include` that turns out to
 * be execute-dominated will not move at all for a faster shaper, and the effort
 * belongs in round-trip count instead — but nobody can know which without the
 * decomposition.
 *
 * So every measurement here splits into the three stages the README's
 * performance contract names:
 *
 *   compile   args shape -> SQL text + binders   (cache miss)
 *   lookup    args shape -> cached plan          (cache hit)
 *   execute   driver round trip
 *   shape     rows -> nested POJOs
 *
 * That split is only *possible* because compile is pure and separate from bind
 * (invariant 2). It is worth noticing that the architecture the earlier
 * iterations were held to is what makes this iteration measurable at all: there
 * is no way to time Prisma's stages apart from each other from outside it, which
 * is why its column here is a single total.
 */

export interface Timing {
  /** Median, in microseconds. The headline: robust to a stray GC pause. */
  p50: number;
  /** 95th percentile, in microseconds. Where the GC pauses show up. */
  p95: number;
  /** Iterations that contributed. */
  runs: number;
}

export interface StageTimings {
  compile?: Timing;
  lookup?: Timing;
  execute?: Timing;
  shape?: Timing;
  /** End-to-end through the public API, which is what a caller actually pays. */
  total: Timing;
}

export interface ScenarioResult {
  scenario: string;
  dialect: string;
  /** Hand-written SQL through Bun's driver — the floor. */
  raw?: Timing;
  /** Prisma client — the thing being replaced. Total only; its stages are opaque. */
  prisma?: Timing;
  gemi: StageTimings;
  /** Rows the scenario returned, so a suspiciously fast run is visible. */
  rows: number;
  notes?: string;
}

/**
 * Times `fn` and returns the distribution.
 *
 * Warmup matters more than iteration count here. JIT tiering means the first
 * dozen calls of a hot path can be an order of magnitude slower than the
 * steady state, and a 20-iteration benchmark that includes them is measuring
 * the compiler rather than the code. The warmup is discarded entirely.
 *
 * `performance.now()` rather than `Date.now()`: the fast scenarios are
 * single-digit microseconds and `Date.now()` has millisecond resolution, which
 * would report every one of them as zero.
 *
 * `batch` exists because `performance.now()` has a resolution floor of its own.
 * The first version of the per-call overhead table reported 42ns for four
 * different things, which is not four measurements agreeing — it is one clock
 * tick divided by one. Anything below roughly a microsecond has to be timed in
 * bulk and divided, so `batch: 1000` times a thousand calls per sample and
 * reports the mean of each batch. The published number is then a real
 * measurement rather than an artefact of the timer.
 */
export async function time(
  fn: () => unknown | Promise<unknown>,
  options: { runs?: number; warmup?: number; batch?: number } = {},
): Promise<Timing> {
  const runs = options.runs ?? 200;
  const batch = options.batch ?? 1;
  const warmup = options.warmup ?? Math.max(10, Math.floor(runs / 10));

  for (let i = 0; i < warmup; i++) await fn();

  const samples = new Float64Array(runs);
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    for (let j = 0; j < batch; j++) await fn();
    samples[i] = ((performance.now() - started) * 1000) / batch;
  }

  const sorted = Array.from(samples).sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    runs,
  };
}

/** A SQLite database with the committed migrations replayed into it. */
export async function sqliteWorkspace(): Promise<{
  url: string;
  path: string;
  dispose: () => void;
}> {
  const workspace = mkdtempSync(join(tmpdir(), "gemi-orm-bench-"));
  const path = join(workspace, "bench.db");

  const root = join(import.meta.dirname, "../../../prisma/migrations");
  const sql = new SQL(`sqlite://${path}`);
  try {
    const directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const directory of directories) {
      const source = readFileSync(join(root, directory, "migration.sql"), "utf8");
      for (const statement of source.split(/;\s*$/m)) {
        if (statement.trim() === "") continue;
        await sql.unsafe(statement);
      }
    }
  } finally {
    await sql.close();
  }

  return {
    url: `sqlite://${path}`,
    path,
    dispose: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

/**
 * Renders results as the markdown table that gets committed.
 *
 * The **ratio to raw** is the column that matters, and it is the one the plan
 * asks for: absolute microseconds are a property of this machine, while "1.4×
 * hand-written SQL" survives being read a year later on different hardware. A
 * ratio near 1 also says there is nothing left to win in that scenario, which is
 * the most useful thing a performance suite can tell you.
 */
export function renderTable(results: ScenarioResult[]): string {
  const lines: string[] = [];

  lines.push(
    "| Dialect | Scenario | Rows | raw µs | gemi µs | ×raw | Prisma µs | ×raw | compile | lookup | execute | shape |",
  );
  lines.push(
    "| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
  );

  for (const result of results) {
    const raw = result.raw?.p50;
    const ratio = (value?: number) =>
      value !== undefined && raw !== undefined && raw > 0
        ? `${(value / raw).toFixed(2)}×`
        : "—";
    const us = (timing?: Timing) =>
      timing === undefined ? "—" : timing.p50.toFixed(1);

    lines.push(
      `| ${result.dialect} | ${result.scenario} | ${result.rows} | ${us(result.raw)} | ` +
        `${us(result.gemi.total)} | ${ratio(result.gemi.total.p50)} | ` +
        `${us(result.prisma)} | ${ratio(result.prisma?.p50)} | ` +
        `${us(result.gemi.compile)} | ${us(result.gemi.lookup)} | ` +
        `${us(result.gemi.execute)} | ${us(result.gemi.shape)} |`,
    );
  }

  return lines.join("\n");
}

/** Machine and version provenance, so a later regression is attributable. */
export async function provenance(): Promise<string> {
  const sql = new SQL("sqlite://:memory:");
  let sqliteVersion = "unknown";
  try {
    const rows: any = await sql.unsafe("select sqlite_version() as v");
    sqliteVersion = [...rows][0].v;
  } catch {
    // Not worth failing a benchmark run over.
  } finally {
    await sql.close();
  }

  return [
    `- Bun ${Bun.version}`,
    `- SQLite ${sqliteVersion}`,
    `- ${process.platform} ${process.arch}`,
    `- Every timed scenario runs against the bare \`DatabaseManager\`. The`,
    `  statement counter installs a Proxy on the container, and it is installed`,
    `  only for the duration of the counting calls — so no ratio in this document`,
    `  divides a proxied measurement by an unproxied baseline.`,
    `- Postgres figures require a second run with a Postgres-generated Prisma`,
    `  client; the \`.json\` sidecar carries the other dialect's Prisma column`,
    `  forward and marks it.`,
  ].join("\n");
}
