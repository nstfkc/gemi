import { describe, expect, test } from "vitest";
import { generate } from "../generate";
import { fakeProvider } from "../providers/fakeProvider";
import type { ProviderEvent } from "../AgentProvider";
import { s } from "../Schema";
import { Eval } from "./Eval";

const finish = (inputTokens = 10, outputTokens = 2, model?: string): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  ...(model ? { model } : {}),
});
const answer = (value: unknown, model?: string): ProviderEvent[] => [
  { type: "output-delta", delta: JSON.stringify(value) },
  finish(10, 2, model),
];

describe("Eval", () => {
  test("cases × runs, checks, and statistics per case and grader", async () => {
    let calls = 0;
    const suite = Eval.create({
      name: "echo",
      cases: [
        { id: "short", input: { text: "hi" } },
        { id: "long", input: { text: "hello there" } },
      ],
      runs: 3,
      task: async (input) => {
        calls++;
        return { reply: calls === 2 ? "" : input.text.toUpperCase() };
      },
      graders: {
        answered: (out) => out.reply !== "",
        loud: (out, { input }) => out.reply === input.text.toUpperCase(),
        // A score: passes at 0.5.
        length: (out) => Math.min(1, out.reply.length / 5),
        // Not applicable to the short case.
        long: (out, { case: test }) => (test.id === "long" ? out.reply.length > 5 : null),
      },
    });
    const seen: string[] = [];
    const report = await suite.run({ onSample: (sample) => seen.push(`${sample.case}#${sample.run}`) });

    expect(seen).toEqual(["short#1", "short#2", "short#3", "long#1", "long#2", "long#3"]);
    expect(report.totals).toMatchObject({ samples: 6, kept: 6, passed: 3, errors: 0 });
    // "hi" scores 2/5 on length, under the 0.5 threshold, so short fails every run.
    expect(report.cases.short!.passed).toBe(0);
    expect(report.cases.long!.passed).toBe(3);
    expect(report.samples[1]!.grades.answered).toEqual({ pass: false, score: 0 });
    expect(report.samples[0]!.grades.long).toBeUndefined();
    expect(report.graders.long!.passRate.n).toBe(3);
    expect(report.cases.long!.passRate).toMatchObject({ n: 3, mean: 1, high: 1 });
    expect(report.cases.long!.passRate.low).toBeLessThan(0.5);
    expect(report.samples[0]!.score).toBeCloseTo((1 + 1 + 0.4) / 3);
  });

  test("a task that throws is a failed sample, and a grader that throws a failed grade", async () => {
    const suite = Eval.create({
      name: "errors",
      cases: [
        { id: "boom", input: 1 },
        { id: "fine", input: 2 },
      ],
      task: async (input) => {
        if (input === 1) throw new Error("no model");
        return input;
      },
      graders: {
        positive: (out) => out > 0,
        broken: () => {
          throw new Error("grader bug");
        },
      },
    });
    const report = await suite.run();
    expect(report.samples[0]).toMatchObject({ case: "boom", pass: false, score: 0, error: "no model", grades: {} });
    expect(report.samples[1]!.grades.broken).toEqual({ pass: false, score: 0, error: "grader bug" });
    expect(report.totals.errors).toBe(1);
  });

  test("a failed gate leaves the sample out of the statistics", async () => {
    const suite = Eval.create({
      name: "gate",
      cases: [
        { id: "empty", input: "" },
        { id: "full", input: "words here" },
      ],
      task: (input) => input,
      graders: {
        content: { check: (out) => out.length > 0, gate: true },
        // Passes on absence: an empty answer would win it.
        noLorem: (out) => !/lorem/.test(out),
      },
    });
    const report = await suite.run();
    expect(report.samples[0]).toMatchObject({ excluded: true, pass: false });
    expect(report.totals).toMatchObject({ samples: 2, kept: 1, passed: 1 });
    expect(report.graders.noLorem!.passRate.n).toBe(1);
  });

  test("a case can skip graders, and only/runs are honoured", async () => {
    const suite = Eval.create({
      name: "skip",
      cases: [
        { id: "a", input: 1, skip: ["strict"] },
        { id: "b", input: 2 },
      ],
      task: (input) => input,
      graders: { strict: () => false, ok: () => true },
    });
    const report = await suite.run({ only: ["a"], runs: 2 });
    expect(report.samples.map((sample) => sample.case)).toEqual(["a", "a"]);
    expect(report.totals.passed).toBe(2);
    await expect(suite.run({ only: ["nope"] })).rejects.toThrow(/no case "nope"/);
  });

  test("a judge grades with generate, votes over samples, and its calls are metered apart", async () => {
    const taskProvider = fakeProvider(answer({ text: "There's no moon yet. Shall I add one?" }, "task-model"));
    const judge = fakeProvider(
      answer({ offers: true, reason: "offers it" }, "judge-model"),
      answer({ offers: false, reason: "doesn't" }, "judge-model"),
      answer({ offers: true, reason: "offers it" }, "judge-model"),
    );
    const suite = Eval.create({
      name: "moon",
      cases: [{ id: "moon", input: { ask: "Where is the moon?" } }],
      task: async (input) => {
        const result = await generate({
          provider: taskProvider,
          prompt: input.ask,
          output: s.object({ text: s.string() }),
        });
        return result.ok ? result.output.text : "";
      },
      graders: ({ judge: judgeWith }) => ({
        offers: judgeWith({
          provider: judge,
          instructions: "Grade the reply.",
          prompt: (out, { input }) => `Asked: ${input.ask}\n\nReply: ${out}`,
          output: s.object({ offers: s.boolean(), reason: s.string() }),
          verdict: (judgment) => ({ pass: judgment.offers, note: judgment.reason }),
          samples: 3,
        }),
      }),
      pricing: {
        "task-model": { input: 1, output: 10 },
        judge: { input: 2, output: 20 },
      },
    });
    const report = await suite.run({ keepOutputs: true });
    const [sample] = report.samples;
    expect(judge.calls).toHaveLength(3);
    expect(judge.calls[0]!.systemPrompt).toBe("Grade the reply.");
    expect(sample!.grades.offers).toMatchObject({ pass: true, note: "offers it | doesn't | offers it" });
    expect(sample!.grades.offers!.score).toBeCloseTo(2 / 3);
    expect(sample!.output).toBe("There's no moon yet. Shall I add one?");
    expect(sample!.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(sample!.judgeUsage).toMatchObject({ inputTokens: 30, outputTokens: 6 });
    // 10 in × $1 + 2 out × $10, and 30 × $2 + 6 × $20 (prefix "judge"), per million.
    expect(sample!.cost).toBeCloseTo((10 + 20 + 60 + 120) / 1e6, 12);
    expect(report.totals.cost).toBeCloseTo(sample!.cost!, 12);
    expect(report.totals.unpriced).toEqual([]);
  });

  test("a judge that fails is a failed grade naming it", async () => {
    const judge = fakeProvider([{ type: "output-delta", delta: "not json" }, finish()]);
    const suite = Eval.create({
      name: "broken-judge",
      cases: [{ id: "x", input: 1 }],
      task: (input) => input,
      graders: {
        judged: Eval.judge({
          provider: judge,
          prompt: (out) => String(out),
          output: s.object({ ok: s.boolean() }),
          verdict: (judgment) => judgment.ok,
        }),
      },
    });
    const report = await suite.run();
    expect(report.samples[0]!.grades.judged).toMatchObject({ pass: false, score: 0 });
    expect(report.samples[0]!.grades.judged!.error).toMatch(/The judge failed/);
  });

  test("judge calibration reports agreement on known examples", async () => {
    const judge = fakeProvider(
      answer({ ok: true }),
      answer({ ok: true }), // disagrees: expected false
      answer({ ok: false }),
      answer({ ok: true }), // the suite's own sample
    );
    const suite = Eval.create({
      name: "calibrated",
      cases: [{ id: "x", input: "q" }],
      task: () => "an answer",
      graders: {
        judged: Eval.judge({
          provider: judge,
          prompt: (out) => out,
          output: s.object({ ok: s.boolean() }),
          verdict: (judgment) => judgment.ok,
          calibration: {
            examples: [
              { id: "good", input: "q", output: "right", expected: true },
              { id: "bad", input: "q", output: "wrong", expected: false },
              { input: "q", output: "wrong too", expected: false },
            ],
            minAgreement: 0.9,
          },
        }),
      },
    });
    const report = await suite.run();
    expect(report.calibration.judged).toMatchObject({
      n: 3,
      ok: false,
      disagreements: [{ id: "bad", expected: false, got: true }],
    });
    expect(report.calibration.judged!.agreement).toBeCloseTo(2 / 3);
    expect(report.samples[0]!.pass).toBe(true);
  });

  test("concurrency runs samples side by side, in case order in the report", async () => {
    let running = 0;
    let most = 0;
    const suite = Eval.create({
      name: "parallel",
      cases: [1, 2, 3, 4].map((n) => ({ id: `c${n}`, input: n })),
      concurrency: 2,
      task: async (input) => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5 * (5 - input)));
        running--;
        return input;
      },
      graders: { ok: () => true },
    });
    const report = await suite.run();
    expect(most).toBe(2);
    expect(report.samples.map((sample) => sample.case)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("a sample no grader applied to is ungraded, not a pass", async () => {
    const suite = Eval.create({
      name: "ungraded",
      cases: [
        { id: "a", input: 1 },
        { id: "b", input: 2 },
      ],
      task: (input) => input,
      graders: { onlyB: (out) => (out === 2 ? true : null) },
    });
    const report = await suite.run();
    expect(report.samples[0]).toMatchObject({ pass: false, excluded: true, ungraded: true, score: 0 });
    expect(report.totals).toMatchObject({ samples: 2, kept: 1, passed: 1 });
  });

  test("a gate's own pass rate counts the samples it excluded", async () => {
    const suite = Eval.create({
      name: "gate-rate",
      cases: [
        { id: "empty", input: "" },
        { id: "full", input: "x" },
      ],
      task: (input) => input,
      graders: { content: { check: (out) => out !== "", gate: true } },
    });
    const report = await suite.run();
    expect(report.graders.content!.passRate).toMatchObject({ n: 2, mean: 0.5 });
  });

  test("an onSample that throws stops the run and rejects with its error", async () => {
    let started = 0;
    const suite = Eval.create({
      name: "throws",
      cases: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `c${n}`, input: n })),
      concurrency: 2,
      task: async (input, { signal }) => {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return signal.aborted ? -input : input;
      },
      graders: { ok: () => true },
    });
    await expect(
      suite.run({
        onSample: () => {
          throw new Error("printer jammed");
        },
      }),
    ).rejects.toThrow("printer jammed");
    expect(started).toBe(2);
  });

  test("judges get the run's signal", async () => {
    const judge = fakeProvider(answer({ ok: true }));
    const controller = new AbortController();
    const suite = Eval.create({
      name: "judged",
      cases: [{ id: "x", input: 1 }],
      task: (input) => input,
      graders: ({ judge: judgeWith }) => ({
        judged: judgeWith({
          provider: judge,
          prompt: (out) => String(out),
          output: s.object({ ok: s.boolean() }),
          verdict: (judgment) => judgment.ok,
        }),
      }),
    });
    await suite.run({ signal: controller.signal });
    expect(judge.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("create refuses duplicate case ids and bad counts", () => {
    const task = (input: number) => input;
    expect(() =>
      Eval.create({ name: "d", cases: [{ id: "a", input: 1 }, { id: "a", input: 2 }], task, graders: {} }),
    ).toThrow(/two cases with the id "a"/);
    expect(() => Eval.create({ name: "r", cases: [], runs: 0, task, graders: {} })).toThrow(/`runs`/);
  });
});

describe("Eval.compare and Eval.format", () => {
  const suite = (passes: boolean[], cases = ["only"]) => {
    let at = 0;
    return Eval.create({
      name: "flaky",
      cases: cases.map((id) => ({ id, input: null })),
      runs: passes.length,
      task: () => passes[at++ % passes.length]!,
      graders: { pass: (out) => out },
    });
  };

  test("a consistent drop is a regression; noise and tiny samples are not", async () => {
    const before = await suite([true, true, true, true, true, true]).run();
    const after = await suite([false, false, false, false, false, false]).run();

    const dropped = Eval.compare(before, after);
    expect(dropped.totals.passRate).toMatchObject({ before: 1, after: 0, delta: -1, significant: true });
    expect(dropped.regressions.some((line) => line.startsWith("case only: pass rate 1.00 → 0.00"))).toBe(true);
    expect(dropped.comparisons).toBe(3);
    expect(dropped.adjust).toBe("holm");

    const noisy = await suite([true, false, true, true, true, false]).run();
    expect(Eval.compare(before, noisy).regressions).toEqual([]);

    // 2/2 → 0/2: Fisher's p is 1/3.
    expect(Eval.compare(await suite([true, true]).run(), await suite([false, false]).run()).regressions).toEqual([]);
  });

  test("a case or grader missing from the current report is a regression", async () => {
    const before = await suite([true, true], ["a", "b", "c"]).run();
    const after = await suite([true, true], ["a", "b", "c"]).run({ only: ["a"] });
    const diff = Eval.compare(before, after);
    expect(diff.missing.cases.fromCurrent).toEqual(["b", "c"]);
    expect(diff.regressions).toContain("case b: in the baseline, missing from this report");
  });

  test("an aborted run is marked, and compare refuses it", async () => {
    const controller = new AbortController();
    const slow = Eval.create({
      name: "slow",
      cases: ["a", "b", "c"].map((id) => ({ id, input: id })),
      task: async (input) => {
        if (input === "a") controller.abort();
        return input;
      },
      graders: { ok: () => true },
    });
    const report = await slow.run({ signal: controller.signal });
    expect(report.aborted).toBe(true);
    expect(report.planned).toEqual(["a", "b", "c"]);
    expect(report.samples.map((sample) => sample.case)).toEqual(["a"]);
    const full = await slow.run();
    expect(full.aborted).toBe(false);
    expect(() => Eval.compare(full, report)).toThrow(/was aborted/);
    expect(Eval.format(report)).toContain("ABORTED");
  });

  test("a report is plain JSON, and formats as a table with deltas", async () => {
    const before = JSON.parse(JSON.stringify(await suite([true, true, true, true, true]).run()));
    const after = await suite([false, false, false, false, false]).run();
    const text = Eval.format(after, { baseline: before });
    expect(text).toContain("eval flaky: 5 samples, 5 kept, 0 passed, 0 errors");
    expect(text).toMatch(/only\s+5\/5\s+0\.00 \[0\.00, 0\.43\] -1\.00\*/);
    expect(text).toContain("0.00 (no spread)");
    expect(text).toMatch(/regression: case only: pass rate 1\.00 → 0\.00 \(p = /);
    expect(text).toContain("Holm-adjusted");
    expect(text).toContain("tokens: task 0 in, 0 out; judges 0 in, 0 out");
  });
});
