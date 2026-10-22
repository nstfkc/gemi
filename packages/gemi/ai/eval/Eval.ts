import type { AgentProvider } from "../AgentProvider";
import type { ReasoningEffort } from "../Agent";
import { generate } from "../generate";
import { addUsage, emptyUsage } from "../runtime";
import type { Infer, Schema } from "../Schema";
import type { AgentMessage, Usage } from "../types";
import { measureUsage, priceUsage, type ModelPrice } from "../usageMeter";
import {
  adjust,
  meanOf,
  passRate,
  passRateDelta,
  scoreDelta,
  type Delta,
  type Estimate,
} from "./stats";

/**
 * A shared eval harness (#1005): cases × runs, graders, LLM judges, judge
 * calibration, statistics, token and cost accounting, and a baseline compare.
 *
 *     const suite = Eval.create({
 *       name: "questions",
 *       cases: [{ id: "moon", input: { ask: "Where is the moon?" } }],
 *       runs: 3,
 *       task: async (input) => ask(input.ask),
 *       graders: {
 *         answered: (out) => out.reply.trim() !== "",
 *         offers: Eval.judge({ provider, prompt: (out) => out.reply, output, verdict }),
 *       },
 *     });
 *     const report = await suite.run();
 *     console.log(Eval.format(report));
 *
 * See docs/ai-evals.md.
 */

// --- grades ----------------------------------------------------------------

/** What a grader may answer: `true`/`false`, a score in [0, 1], a result, or
 *  `null`/`undefined` for "does not apply to this sample". */
export type GradeValue = boolean | number | GraderResult | null | undefined;

export type GraderResult = {
  pass: boolean;
  /** In [0, 1]. Defaults to 1 for a pass and 0 for a fail. */
  score?: number;
  note?: string;
};

/** A grader's verdict on one sample, as the report keeps it. */
export type Grade = {
  pass: boolean;
  score: number;
  note?: string;
  /** Set when the grader threw: the grade is then a fail. */
  error?: string;
};

// --- cases, tasks and graders ----------------------------------------------

export type EvalCase<I> = {
  id: string;
  input: I;
  /** Grader names that don't apply to this case (an owner who asked for
   *  what a grader would flag, say). */
  skip?: readonly string[];
};

export type EvalTaskContext<I> = {
  case: EvalCase<I>;
  /** 1-based. */
  run: number;
  /** Aborted when the suite's `signal` is. */
  signal: AbortSignal;
};

export type GraderContext<I> = {
  case: EvalCase<I>;
  input: I;
  /** 1-based; 0 for a calibration example. */
  run: number;
};

export type CheckFn<I, O> = (
  output: O,
  ctx: GraderContext<I>,
) => GradeValue | Promise<GradeValue>;

type GraderOptions = {
  /**
   * A gate: when it fails, the sample is reported but left out of every pass
   * rate and score. For a content guard, so an empty answer can't win the
   * graders that pass when something is absent.
   */
  gate?: boolean;
  /** The score a numeric answer passes at. Default 0.5. */
  threshold?: number;
};

export type CheckGrader<I, O> = GraderOptions & { check: CheckFn<I, O>; kind?: "check" };

export type JudgePrompt =
  | string
  | { prompt?: string; messages?: AgentMessage[] };

export type JudgeCalibration<I, O> = {
  /** Outputs with a known answer, graded before the suite runs. */
  examples: readonly { id?: string; input: I; output: O; expected: boolean }[];
  /** Below this agreement, `report.calibration[name].ok` is false. Default 0.8. */
  minAgreement?: number;
};

export type JudgeSpec<I, O, J extends Schema<any>> = GraderOptions & {
  provider: AgentProvider;
  instructions?: string;
  /** What the judge reads: a prompt, or messages (an image, say). */
  prompt: (output: O, ctx: GraderContext<I>) => JudgePrompt | Promise<JudgePrompt>;
  /** The judgment's schema. */
  output: J;
  /**
   * The grade, from the judgment.
   *
   * Declared as a method on purpose (#1007): a judge sits in the graders'
   * union as `JudgeGrader<I, O, any>`, whose judgment is `Infer<any>`, i.e.
   * `unknown`. A property's function type is checked contravariantly under
   * `strictFunctionTypes`, so a judge whose `verdict` reads `{ ok: boolean }`
   * would not be assignable there; a method's parameters are checked
   * bivariantly, so it is. The judgment is still typed by `output` where the
   * judge is written.
   */
  verdict(judgment: Infer<J>, ctx: GraderContext<I>): GradeValue;
  reasoning?: ReasoningEffort;
  maxOutputTokens?: number;
  temperature?: number;
  /** Judge each sample this many times: the majority passes (a tie fails)
   *  and the score is the mean. Default 1. */
  samples?: number;
  calibration?: JudgeCalibration<I, O>;
};

export type JudgeGrader<I, O, J extends Schema<any> = Schema<any>> = JudgeSpec<I, O, J> & {
  readonly kind: "judge";
};

export type EvalGrader<I, O> = CheckFn<I, O> | CheckGrader<I, O> | JudgeGrader<I, O, any>;

export type EvalGraders<I, O> = Record<string, EvalGrader<I, O>>;

/** What a `graders` function is handed. */
export type GraderKit<I, O> = {
  judge: <J extends Schema<any>>(spec: JudgeSpec<I, O, J>) => JudgeGrader<I, O, J>;
};

/** Prices by model id. A key also prices the ids it is a prefix of
 *  (`gpt-5.4` prices `gpt-5.4-2026-03-05`); the longest key wins. */
export type EvalPricing = Record<string, ModelPrice>;
export type { ModelPrice };

export type CreateEvalParams<I, O> = {
  name: string;
  cases: readonly EvalCase<I>[];
  /** Runs per case. Default 1. */
  runs?: number;
  /** Samples at once. Default 1. */
  concurrency?: number;
  task: (input: I, ctx: EvalTaskContext<I>) => O | Promise<O>;
  /**
   * By name. A function of the kit when a judge is among them: its `judge`
   * is typed by this eval's input and output, so a judge's `prompt` and
   * `verdict` need no annotations.
   */
  graders: EvalGraders<I, O> | ((kit: GraderKit<I, O>) => EvalGraders<I, O>);
  pricing?: EvalPricing;
};

// --- the report --------------------------------------------------------------

export type EvalSample<O = unknown> = {
  case: string;
  run: number;
  /** Every applicable grade passed (and the task didn't throw). False when
   *  no grader applied. */
  pass: boolean;
  /** Left out of the statistics: a gate failed, or no grader applied
   *  (`ungraded`). Still reported. */
  excluded: boolean;
  /** No grader applied to this sample: nothing checked it, so it is neither
   *  a pass nor a fail. */
  ungraded?: true;
  /** The mean of the grades' scores; 0 when the task threw or nothing graded it. */
  score: number;
  /** By grader name; graders that answered "does not apply" are absent. */
  grades: Record<string, Grade>;
  /** The task threw this. No grader ran. */
  error?: string;
  /** With `keepOutputs`. */
  output?: O;
  /** The task's model calls. */
  usage: Usage;
  byModel: Record<string, Usage>;
  /** The judges' model calls. */
  judgeUsage: Usage;
  /** USD, the task's and the judges', when `pricing` prices their models. */
  cost?: number;
  durationMs: number;
};

export type GraderSummary = { passRate: Estimate; score: Estimate };

export type EvalSummary = {
  samples: number;
  /** Samples counted in the statistics: no gate failed and some grader applied. */
  kept: number;
  passed: number;
  /** Samples whose task threw. */
  errors: number;
  passRate: Estimate;
  score: Estimate;
};

export type CaseSummary = EvalSummary & { graders: Record<string, GraderSummary> };

export type CalibrationResult = {
  n: number;
  /** The share of examples the judge graded as expected. */
  agreement: number;
  ok: boolean;
  disagreements: { id: string; expected: boolean; got: boolean; note?: string }[];
  usage: Usage;
};

export type EvalReport<O = unknown> = {
  name: string;
  startedAt: string;
  durationMs: number;
  runs: number;
  /**
   * The run was stopped (`signal`, or an `onSample` that threw) before every
   * planned sample ran. Its statistics cover only what ran, so
   * `Eval.compare` refuses it.
   */
  aborted: boolean;
  /** The case ids this run was asked for (after `only`), whether or not all ran. */
  planned: string[];
  samples: EvalSample<O>[];
  cases: Record<string, CaseSummary>;
  graders: Record<string, GraderSummary>;
  calibration: Record<string, CalibrationResult>;
  totals: EvalSummary & {
    usage: Usage;
    judgeUsage: Usage;
    byModel: Record<string, Usage>;
    /** USD over every sample, when `pricing` was given. */
    cost?: number;
    /** Models used that `pricing` doesn't price. */
    unpriced: string[];
  };
};

export type EvalRunOptions<O> = {
  /** Case ids to run; all when absent. */
  only?: readonly string[];
  runs?: number;
  concurrency?: number;
  signal?: AbortSignal;
  /** Keep each sample's output on the report. Default false. */
  keepOutputs?: boolean;
  /** Called as each sample is graded. If it throws, the run stops starting
   *  samples (and aborts the ones running), then rejects with that error. */
  onSample?: (sample: EvalSample<O>) => void;
};

export type EvalCompareOptions = {
  /** Default 0.05. */
  alpha?: number;
  /**
   * How `alpha` is held across the comparison's many tests (every case and
   * grader, on pass rate and score). `"holm"` (default): Holm's step-down,
   * so the chance of any false "significant" in the whole comparison stays
   * under `alpha`. `"none"`: each test at `alpha` alone, which with 20 cases
   * flags about two changes per comparison by chance.
   */
  adjust?: "holm" | "none";
};

export type EvalComparison = {
  totals: { passRate: Delta; score: Delta };
  cases: Record<string, { passRate: Delta; score: Delta }>;
  graders: Record<string, { passRate: Delta; score: Delta }>;
  /**
   * Cases and graders only one report has. One the current report lacks is
   * also a regression: a case that didn't run is not a case that passed.
   */
  missing: {
    cases: { fromCurrent: string[]; fromBaseline: string[] };
    graders: { fromCurrent: string[]; fromBaseline: string[] };
  };
  /** Tests that had a p (the family `adjust` corrects over). */
  comparisons: number;
  alpha: number;
  adjust: "holm" | "none";
  /** "case moon: pass rate 1.00 → 0.00 (p = 0.029)" for each significant
   *  drop, and each case or grader missing from the current report. */
  regressions: string[];
  improvements: string[];
};

// --- the suite ---------------------------------------------------------------

export class Eval<I = unknown, O = unknown> {
  readonly name: string;
  readonly cases: readonly EvalCase<I>[];
  readonly runs: number;
  readonly concurrency: number;
  readonly graders: Readonly<Record<string, EvalGrader<I, O>>>;
  readonly pricing?: EvalPricing;
  private readonly task: CreateEvalParams<I, O>["task"];

  private constructor(params: CreateEvalParams<I, O>) {
    this.name = params.name;
    this.cases = params.cases;
    this.runs = params.runs ?? 1;
    this.concurrency = params.concurrency ?? 1;
    this.task = params.task;
    this.graders =
      typeof params.graders === "function"
        ? params.graders({ judge: (spec) => Eval.judge(spec) })
        : params.graders;
    this.pricing = params.pricing;
  }

  static create<I, O>(params: CreateEvalParams<I, O>): Eval<I, Awaited<O>> {
    const owner = `The eval "${params.name}"`;
    assertCount(params.runs, owner, "runs");
    assertCount(params.concurrency, owner, "concurrency");
    const ids = new Set<string>();
    for (const test of params.cases) {
      if (ids.has(test.id)) throw new Error(`${owner} has two cases with the id "${test.id}".`);
      ids.add(test.id);
    }
    const suite = new Eval(params as unknown as CreateEvalParams<I, Awaited<O>>);
    for (const [name, grader] of Object.entries(suite.graders)) {
      if (typeof grader !== "function" && grader.kind === "judge") {
        assertCount(grader.samples, `${owner}'s judge "${name}"`, "samples");
      }
    }
    return suite;
  }

  /**
   * An LLM judge: `prompt` turns an output into what the judge reads, the
   * judge answers `output`, and `verdict` turns that into a grade.
   */
  static judge<I, O, J extends Schema<any>>(spec: JudgeSpec<I, O, J>): JudgeGrader<I, O, J> {
    return { ...spec, kind: "judge" };
  }

  /**
   * Compares a report with a baseline. Throws when either was aborted: its
   * statistics are of the samples that happened to run.
   */
  static compare(
    baseline: EvalReport<any>,
    current: EvalReport<any>,
    options: EvalCompareOptions = {},
  ): EvalComparison {
    return compareReports(baseline, current, options);
  }

  static format(
    report: EvalReport<any>,
    options: { baseline?: EvalReport<any> } & EvalCompareOptions = {},
  ): string {
    return formatReport(report, options);
  }

  /** Calibrates the judges, then runs every case `runs` times and grades it. */
  async run(options: EvalRunOptions<O> = {}): Promise<EvalReport<O>> {
    const owner = `${this.name}.run`;
    assertCount(options.runs, owner, "runs");
    assertCount(options.concurrency, owner, "concurrency");
    const only = options.only ? new Set(options.only) : null;
    if (only) {
      const unknown = [...only].filter((id) => !this.cases.some((test) => test.id === id));
      if (unknown.length > 0) {
        throw new Error(`The eval "${this.name}" has no case ${unknown.map((id) => `"${id}"`).join(", ")}.`);
      }
    }
    const runs = options.runs ?? this.runs;
    const started = Date.now();
    // The caller's signal, and ours: a throwing `onSample` stops the other
    // workers rather than leaving them to spend tokens for a rejected run.
    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
    const selected = this.cases.filter((test) => !only || only.has(test.id));

    const calibration: Record<string, CalibrationResult> = {};
    for (const [name, grader] of Object.entries(this.graders)) {
      if (signal.aborted) break;
      if (typeof grader === "function" || grader.kind !== "judge" || !grader.calibration) continue;
      calibration[name] = await this.calibrate(grader, signal);
    }

    const jobs = selected.flatMap((test) =>
      Array.from({ length: runs }, (_, at) => ({ test, run: at + 1 })),
    );
    const samples: (EvalSample<O> | undefined)[] = Array.from({ length: jobs.length });
    let next = 0;
    let failure: { error: unknown } | undefined;
    const worker = async () => {
      while (next < jobs.length && !signal.aborted) {
        const at = next++;
        const job = jobs[at]!;
        const sample = await this.sample(job.test, job.run, signal, options.keepOutputs ?? false);
        samples[at] = sample;
        try {
          options.onSample?.(sample);
        } catch (error) {
          failure ??= { error };
          stop.abort(error);
        }
      }
    };
    const workers = Math.min(options.concurrency ?? this.concurrency, jobs.length);
    await Promise.all(Array.from({ length: workers }, worker));
    if (failure) throw failure.error;

    const ran = samples.filter((sample): sample is EvalSample<O> => sample !== undefined);
    return this.report(
      ran,
      calibration,
      runs,
      new Date(started).toISOString(),
      Date.now() - started,
      { aborted: signal.aborted || ran.length < jobs.length, planned: selected.map((test) => test.id) },
    );
  }

  private async sample(
    test: EvalCase<I>,
    run: number,
    signal: AbortSignal,
    keepOutput: boolean,
  ): Promise<EvalSample<O>> {
    const started = Date.now();
    let output: O | undefined;
    let error: string | undefined;
    const task = await measureUsage(async () => {
      try {
        output = await this.task(test.input, { case: test, run, signal });
      } catch (thrown) {
        error = messageOf(thrown);
      }
    });

    const grades: Record<string, Grade> = {};
    let excluded = false;
    const judged = await measureUsage(async () => {
      if (error !== undefined) return;
      const ctx: GraderContext<I> = { case: test, input: test.input, run };
      for (const [name, grader] of Object.entries(this.graders)) {
        if (test.skip?.includes(name)) continue;
        const grade = await gradeWith(grader, output as O, ctx, signal);
        if (!grade) continue;
        grades[name] = grade;
        if (!grade.pass && typeof grader !== "function" && grader.gate) excluded = true;
      }
    });

    const scores = Object.values(grades).map((grade) => grade.score);
    // Nothing applied: not a pass with a perfect score, which would lift the
    // pass rate with samples nobody checked. Left out instead.
    const ungraded = error === undefined && scores.length === 0;
    const priced = this.pricing
      ? costOf(this.pricing, task.byModel).cost + costOf(this.pricing, judged.byModel).cost
      : undefined;
    return {
      case: test.id,
      run,
      pass: error === undefined && !ungraded && Object.values(grades).every((grade) => grade.pass),
      excluded: excluded || ungraded,
      ...(ungraded ? { ungraded: true as const } : {}),
      score: error !== undefined || ungraded ? 0 : mean(scores),
      grades,
      ...(error !== undefined ? { error } : {}),
      ...(keepOutput && error === undefined ? { output } : {}),
      usage: task.usage,
      byModel: mergeByModel(task.byModel, judged.byModel),
      judgeUsage: judged.usage,
      ...(priced !== undefined ? { cost: priced } : {}),
      durationMs: Date.now() - started,
    };
  }

  private async calibrate(
    grader: JudgeGrader<I, O, any>,
    signal: AbortSignal,
  ): Promise<CalibrationResult> {
    const calibration = grader.calibration!;
    const disagreements: CalibrationResult["disagreements"] = [];
    let agreed = 0;
    const measured = await measureUsage(async () => {
      for (const [index, example] of calibration.examples.entries()) {
        if (signal.aborted) break;
        const id = example.id ?? `example-${index + 1}`;
        const ctx: GraderContext<I> = { case: { id, input: example.input }, input: example.input, run: 0 };
        const grade = await gradeWith(grader, example.output, ctx, signal);
        const got = grade?.pass ?? false;
        if (got === example.expected) agreed++;
        else disagreements.push({ id, expected: example.expected, got, ...(grade?.note ? { note: grade.note } : {}) });
      }
    });
    const n = calibration.examples.length;
    const agreement = n === 0 ? 1 : agreed / n;
    return {
      n,
      agreement,
      ok: agreement >= (calibration.minAgreement ?? 0.8),
      disagreements,
      usage: measured.usage,
    };
  }

  private report(
    samples: EvalSample<O>[],
    calibration: Record<string, CalibrationResult>,
    runs: number,
    startedAt: string,
    durationMs: number,
    progress: { aborted: boolean; planned: string[] },
  ): EvalReport<O> {
    const gates = new Set(
      Object.entries(this.graders)
        .filter(([, grader]) => typeof grader !== "function" && grader.gate)
        .map(([name]) => name),
    );
    const cases: Record<string, CaseSummary> = {};
    for (const test of this.cases) {
      const mine = samples.filter((sample) => sample.case === test.id);
      if (mine.length === 0) continue;
      cases[test.id] = { ...summarize(mine), graders: summarizeGraders(mine, gates) };
    }
    let usage = emptyUsage();
    let judgeUsage = emptyUsage();
    const byModel: Record<string, Usage> = {};
    for (const sample of samples) {
      usage = addUsage(usage, sample.usage);
      judgeUsage = addUsage(judgeUsage, sample.judgeUsage);
      for (const [model, used] of Object.entries(sample.byModel)) {
        byModel[model] = addUsage(byModel[model] ?? emptyUsage(), used);
      }
    }
    const priced = this.pricing ? costOf(this.pricing, byModel) : undefined;
    return {
      name: this.name,
      startedAt,
      durationMs,
      runs,
      aborted: progress.aborted,
      planned: progress.planned,
      samples,
      cases,
      graders: summarizeGraders(samples, gates),
      calibration,
      totals: {
        ...summarize(samples),
        usage,
        judgeUsage,
        byModel,
        ...(priced ? { cost: priced.cost } : {}),
        unpriced: priced ? priced.unpriced : Object.keys(byModel),
      },
    };
  }
}

// --- grading -----------------------------------------------------------------

async function gradeWith<I, O>(
  grader: EvalGrader<I, O>,
  output: O,
  ctx: GraderContext<I>,
  signal: AbortSignal,
): Promise<Grade | null> {
  const threshold = typeof grader === "function" ? 0.5 : (grader.threshold ?? 0.5);
  try {
    if (typeof grader === "function") return toGrade(await grader(output, ctx), threshold);
    if (grader.kind !== "judge") return toGrade(await grader.check(output, ctx), threshold);
    return await judgeWith(grader, output, ctx, threshold, signal);
  } catch (thrown) {
    return { pass: false, score: 0, error: messageOf(thrown) };
  }
}

async function judgeWith<I, O>(
  judge: JudgeGrader<I, O, any>,
  output: O,
  ctx: GraderContext<I>,
  threshold: number,
  signal: AbortSignal,
): Promise<Grade | null> {
  const asked = await judge.prompt(output, ctx);
  const input = typeof asked === "string" ? { prompt: asked } : asked;
  const grades: Grade[] = [];
  for (let at = 0; at < (judge.samples ?? 1) && !signal.aborted; at++) {
    const result = await generate({
      signal,
      provider: judge.provider,
      ...(judge.instructions !== undefined ? { instructions: judge.instructions } : {}),
      ...input,
      output: judge.output,
      ...(judge.reasoning !== undefined ? { reasoning: judge.reasoning } : {}),
      ...(judge.maxOutputTokens !== undefined ? { maxOutputTokens: judge.maxOutputTokens } : {}),
      ...(judge.temperature !== undefined ? { temperature: judge.temperature } : {}),
      logErrors: false,
    });
    if (!result.ok) {
      grades.push({ pass: false, score: 0, error: `The judge failed: ${result.error.message}` });
      continue;
    }
    const grade = toGrade(judge.verdict(result.output, ctx), threshold);
    if (grade) grades.push(grade);
  }
  if (grades.length === 0) return null;
  if (grades.length === 1) return grades[0]!;
  const passes = grades.filter((grade) => grade.pass).length;
  const notes = grades.map((grade) => grade.note ?? grade.error).filter(Boolean);
  const errors = grades.map((grade) => grade.error).filter(Boolean);
  return {
    pass: passes * 2 > grades.length,
    score: mean(grades.map((grade) => grade.score)),
    ...(notes.length > 0 ? { note: notes.join(" | ") } : {}),
    ...(errors.length === grades.length ? { error: errors.join(" | ") } : {}),
  };
}

function toGrade(value: GradeValue, threshold: number): Grade | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return { pass: value, score: value ? 1 : 0 };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`A grader answered the score ${value}.`);
    const score = clamp(value);
    return { pass: score >= threshold, score };
  }
  return {
    pass: value.pass,
    score: value.score === undefined ? (value.pass ? 1 : 0) : clamp(value.score),
    ...(value.note !== undefined ? { note: value.note } : {}),
  };
}

// --- statistics --------------------------------------------------------------

function summarize(samples: readonly EvalSample<any>[]): EvalSummary {
  const kept = samples.filter((sample) => !sample.excluded);
  return {
    samples: samples.length,
    kept: kept.length,
    passed: kept.filter((sample) => sample.pass).length,
    errors: samples.filter((sample) => sample.error !== undefined).length,
    passRate: passRate(kept.map((sample) => sample.pass)),
    score: meanOf(kept.map((sample) => sample.score)),
  };
}

/**
 * Per grader, over the kept samples. A gate is summarized over every sample
 * it graded: over the kept ones only, its own failures would have excluded
 * themselves and its rate would always read 1.
 */
function summarizeGraders(
  samples: readonly EvalSample<any>[],
  gates: ReadonlySet<string>,
): Record<string, GraderSummary> {
  const kept = samples.filter((sample) => !sample.excluded);
  const names = [...new Set(samples.flatMap((sample) => Object.keys(sample.grades)))];
  return Object.fromEntries(
    names.map((name) => {
      const from = gates.has(name) ? samples : kept;
      const grades = from.flatMap((sample) => (sample.grades[name] ? [sample.grades[name]!] : []));
      return [
        name,
        {
          passRate: passRate(grades.map((grade) => grade.pass)),
          score: meanOf(grades.map((grade) => grade.score)),
        },
      ];
    }),
  );
}

// --- cost --------------------------------------------------------------------

function costOf(
  pricing: EvalPricing,
  byModel: Record<string, Usage>,
): { cost: number; unpriced: string[] } {
  let cost = 0;
  const unpriced: string[] = [];
  for (const [model, usage] of Object.entries(byModel)) {
    const price = priceUsage(pricing, model, usage);
    if (price === undefined) {
      unpriced.push(model);
      continue;
    }
    cost += price;
  }
  return { cost, unpriced };
}

function mergeByModel(...maps: Record<string, Usage>[]): Record<string, Usage> {
  const merged: Record<string, Usage> = {};
  for (const map of maps) {
    for (const [model, usage] of Object.entries(map)) {
      merged[model] = addUsage(merged[model] ?? emptyUsage(), usage);
    }
  }
  return merged;
}

// --- compare and format ------------------------------------------------------

function compareReports(
  baseline: EvalReport<any>,
  current: EvalReport<any>,
  options: EvalCompareOptions,
): EvalComparison {
  for (const [which, report] of [
    ["baseline", baseline],
    ["current report", current],
  ] as const) {
    if (report.aborted) {
      throw new Error(
        `Eval.compare: the ${which} for "${report.name}" was aborted (${report.samples.length} samples ran). Its statistics cover only the samples that ran; run it again in full.`,
      );
    }
  }
  const alpha = options.alpha ?? 0.05;
  const method = options.adjust ?? "holm";
  const all: { label: string; passRate: Delta; score: Delta }[] = [];
  const pair = (label: string, before: GraderSummary, after: GraderSummary) => {
    const entry = {
      label,
      passRate: passRateDelta(before.passRate, after.passRate),
      score: scoreDelta(before.score, after.score),
    };
    all.push(entry);
    return { passRate: entry.passRate, score: entry.score };
  };
  const both = (label: string, before: Record<string, GraderSummary>, after: Record<string, GraderSummary>) =>
    Object.fromEntries(
      Object.keys(after)
        .filter((key) => key in before)
        .map((key) => [key, pair(`${label} ${key}`, before[key]!, after[key]!)]),
    );
  const missingOf = (before: string[], after: string[]) => ({
    fromCurrent: before.filter((key) => !after.includes(key)),
    fromBaseline: after.filter((key) => !before.includes(key)),
  });

  const totals = pair("total", baseline.totals, current.totals);
  const cases = both("case", baseline.cases, current.cases);
  const graders = both("grader", baseline.graders, current.graders);
  const deltas = all.flatMap((entry) => [entry.passRate, entry.score]);
  adjust(deltas, alpha, method);

  const missing = {
    cases: missingOf(
      [...new Set([...(baseline.planned ?? []), ...Object.keys(baseline.cases)])],
      [...new Set([...(current.planned ?? []), ...Object.keys(current.cases)])],
    ),
    graders: missingOf(Object.keys(baseline.graders), Object.keys(current.graders)),
  };
  const regressions: string[] = [
    ...missing.cases.fromCurrent.map((id) => `case ${id}: in the baseline, missing from this report`),
    ...missing.graders.fromCurrent.map((id) => `grader ${id}: in the baseline, missing from this report`),
  ];
  const improvements: string[] = [];
  for (const entry of all) {
    for (const [what, delta] of [
      ["pass rate", entry.passRate],
      ["score", entry.score],
    ] as const) {
      if (!delta.significant) continue;
      const line = `${entry.label}: ${what} ${delta.before.toFixed(2)} → ${delta.after.toFixed(2)} (p = ${formatP(delta.pAdjusted!)})`;
      (delta.delta < 0 ? regressions : improvements).push(line);
    }
  }
  return {
    totals,
    cases,
    graders,
    missing,
    comparisons: deltas.filter((delta) => delta.p !== null).length,
    alpha,
    adjust: method,
    regressions,
    improvements,
  };
}

function formatP(p: number): string {
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

function formatReport(
  report: EvalReport<any>,
  options: { baseline?: EvalReport<any> } & EvalCompareOptions,
): string {
  const comparison =
    options.baseline && !options.baseline.aborted && !report.aborted
      ? compareReports(options.baseline, report, options)
      : undefined;
  const { totals } = report;
  const lines: string[] = [];
  lines.push(
    `eval ${report.name}: ${totals.samples} samples, ${totals.kept} kept, ${totals.passed} passed, ${totals.errors} errors (${(report.durationMs / 1000).toFixed(1)}s)`,
  );
  if (report.aborted) {
    lines.push(`ABORTED: only ${totals.samples} of the planned samples ran; not comparable.`);
  }
  const rate = (estimate: Estimate) => {
    if (estimate.n === 0) return "-";
    const mean = estimate.mean.toFixed(2);
    if (estimate.low === null || estimate.high === null) {
      return `${mean} (${estimate.n === 1 ? "n=1" : "no spread"})`;
    }
    return `${mean} [${estimate.low.toFixed(2)}, ${estimate.high.toFixed(2)}]`;
  };
  const change = (delta: Delta | undefined) =>
    delta ? ` ${delta.delta >= 0 ? "+" : ""}${delta.delta.toFixed(2)}${delta.significant ? "*" : ""}` : "";
  const table = (title: string, rows: [string, string, string, string][]) => {
    const widths = [0, 1, 2, 3].map((column) =>
      Math.max(...[[title, "n", "pass rate", "score"], ...rows].map((row) => row[column]!.length)),
    );
    const render = (row: string[]) => row.map((cell, at) => cell.padEnd(widths[at]!)).join("  ").trimEnd();
    lines.push("", render([title, "n", "pass rate", "score"]), ...rows.map(render));
  };
  table(
    "case",
    Object.entries(report.cases).map(([id, summary]) => [
      id,
      `${summary.kept}/${summary.samples}`,
      rate(summary.passRate) + change(comparison?.cases[id]?.passRate),
      rate(summary.score) + change(comparison?.cases[id]?.score),
    ]),
  );
  table(
    "grader",
    Object.entries(report.graders).map(([id, summary]) => [
      id,
      String(summary.passRate.n),
      rate(summary.passRate) + change(comparison?.graders[id]?.passRate),
      rate(summary.score) + change(comparison?.graders[id]?.score),
    ]),
  );
  lines.push(
    "",
    `total  pass rate ${rate(totals.passRate)}${change(comparison?.totals.passRate)}  score ${rate(totals.score)}${change(comparison?.totals.score)}`,
  );
  for (const [name, result] of Object.entries(report.calibration)) {
    lines.push(
      `judge ${name}: agreement ${result.agreement.toFixed(2)} on ${result.n} examples${result.ok ? "" : " (BELOW minAgreement)"}`,
    );
  }
  const tokens = (usage: Usage) => `${usage.inputTokens} in, ${usage.outputTokens} out`;
  lines.push(
    `tokens: task ${tokens(totals.usage)}; judges ${tokens(totals.judgeUsage)}${totals.cost !== undefined ? `; cost $${totals.cost.toFixed(4)}` : ""}${totals.unpriced.length > 0 && totals.cost !== undefined ? ` (unpriced: ${totals.unpriced.join(", ")})` : ""}`,
  );
  if (comparison) {
    lines.push(
      "",
      `* significant at ${comparison.alpha} over ${comparison.comparisons} tests (${comparison.adjust === "holm" ? "Holm-adjusted" : "unadjusted"}; Fisher's exact for pass rates, Welch's t for scores)`,
    );
    for (const line of comparison.regressions) lines.push(`regression: ${line}`);
    for (const line of comparison.improvements) lines.push(`improvement: ${line}`);
  }
  return lines.join("\n");
}

// --- helpers -----------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function assertCount(value: number | undefined, owner: string, field: string): void {
  if (value === undefined || (Number.isInteger(value) && value >= 1)) return;
  throw new Error(`${owner} sets \`${field}\` to ${String(value)}, but it has to be a whole number of at least 1.`);
}
