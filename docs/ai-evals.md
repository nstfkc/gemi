# AI Evals

An eval runs a fixed set of cases through your agent (or any model-backed code) several times, grades each answer, and reports how often it passes, how sure you can be of that number, and what it cost. Run it before and after a prompt change and compare the two reports.

```ts
// scripts/question-evals.ts
import { Eval, s } from "gemi/ai";
import { provider } from "@/app/config/ai";
import { askSiteAgent } from "./helpers";

const questions = Eval.create({
  name: "questions",
  cases: [
    { id: "moon", input: { ask: "Where is the moon?", question: true } },
    { id: "tall", input: { ask: "Make the hero taller", question: false } },
  ],
  runs: 3,
  task: async (input) => askSiteAgent(input.ask), // returns { reply, calls }
  graders: ({ judge }) => ({
    answered: (out) => out.reply.trim() !== "",
    changesOnlyWhenAsked: (out, { input }) => (input.question ? out.calls.length === 0 : out.calls.length > 0),
    offersToAdd: judge({
      provider,
      instructions: "You grade a website assistant's reply to a question about the page.",
      prompt: (out, { input }) => `Asked: ${input.ask}\n\nReply:\n${out.reply}`,
      output: s.object({ offers: s.boolean(), reason: s.string() }),
      verdict: (judgment) => ({ pass: judgment.offers, note: judgment.reason }),
    }),
  }),
});

const report = await questions.run();
console.log(Eval.format(report));
process.exit(report.totals.passed === report.totals.kept ? 0 : 1);
```

## Cases and the task

- `cases` is a list of `{ id, input }`. The ids must be unique. `input` is whatever your task needs, and its type flows into the task and every grader.
- `task(input, ctx)` produces the output to grade. `ctx` has the `case`, the 1-based `run` and a `signal`. The output's type is what the graders receive.
- `runs` (default 1) is how many times each case runs, and `concurrency` (default 1) is how many samples run at once.
- A task that throws is a failed sample with its `error`, not a crash. No grader runs on it.

## Graders

`graders` is an object of named graders, or a function returning one. Use the function form when you have a judge: its `judge` is typed by the eval's input and output, so `prompt` and `verdict` need no annotations.

A grader is one of these:

- **A check**, `(output, ctx) => …`, deterministic, possibly async. `ctx` has `case`, `input` and `run`.
- **A check with options**, `{ check, gate?, threshold? }`.
- **A judge**, made with `judge({...})` (or `Eval.judge`), which grades with a model through `generate`.

What a check or a verdict may answer:

| Answer | Grade |
|---|---|
| `true` / `false` | pass with score 1, or fail with score 0 |
| a number | a score in [0, 1] (clamped), which passes at `threshold` (default 0.5) |
| `{ pass, score?, note? }` | as given |
| `null` / `undefined` | doesn't apply to this sample, so it's left out |

A grader that throws is a failed grade, with the message in `error`.

- **Skipping per case.** `{ id, input, skip: ["heritage"] }` leaves those graders out for that case, for example when the owner asked for exactly what the grader would flag.
- **Gates.** When a grader with `gate: true` fails, the sample is reported but left out of every pass rate and score. Use it for a content guard, so that an empty answer can't win the graders that pass when something is absent.

### Judges

```ts
judge({
  provider,                        // the judge's model
  instructions: "…",               // its system prompt
  prompt: (out, ctx) => "…",       // or { prompt?, messages? } to show it an image
  output: s.object({ … }),         // the judgment's schema
  verdict: (judgment, ctx) => …,   // the grade, from the judgment
  reasoning: "low",                // optional, with maxOutputTokens and temperature
  samples: 3,                      // judge 3 times: majority passes, score is the mean
  calibration: { … },              // see below
  gate: false, threshold: 0.5,
})
```

A judge call that fails (an invalid answer or a provider error) is a failed grade whose `error` starts with "The judge failed".

### Calibrating a judge

A judge is only as good as its agreement with you. Give it examples you've graded yourself:

```ts
calibration: {
  examples: [
    { id: "offers", input: { ask: "Where is the moon?", question: true }, output: { reply: "There's no moon yet. Shall I add one?", calls: [] }, expected: true },
    { id: "silent", input: { ask: "Where is the moon?", question: true }, output: { reply: "Done.", calls: [] }, expected: false },
  ],
  minAgreement: 0.8,
},
```

Before the samples run, the judge grades each example. `report.calibration.<grader>` holds `{ n, agreement, ok, disagreements, usage }`, and `ok` is false below `minAgreement` (default 0.8). `Eval.format` flags it.

## The report

`run()` returns an `EvalReport`, a plain JSON object you can save and load later as a baseline.

- `samples`: one per case × run, with `pass`, `excluded`, `score`, `grades` (by grader), `error`, `usage`, `judgeUsage`, `byModel`, `cost` and `durationMs`. With `run({ keepOutputs: true })`, each sample also has its `output`.
- `cases` and `graders`: summaries with `passRate` and `score`.
- `totals`: `samples`, `kept`, `passed`, `errors`, `passRate`, `score`, `usage`, `judgeUsage`, `byModel`, `cost` and `unpriced`.
- `calibration`: per judge.

A sample **passes** when it didn't throw and every applicable grade passed. Its **score** is the mean of its grades' scores.

### Statistics

`passRate` and `score` are `Estimate`s: `{ n, mean, stddev, low, high }`, where `low` and `high` bound the 95% interval.

- A pass rate uses a Wilson interval. Two passes in three runs is 0.67 [0.21, 0.94], which is a reminder of how little three runs say.
- A score uses the mean with a t-based interval.

Excluded samples (a failed gate) are not counted.

### Tokens and cost

Every model call made while a sample's task runs is metered: agent steps, `generate`, and `ImageModel` calls, however deep in your code, with no provider to pass around. Judges' calls are metered separately as `judgeUsage`. Give `pricing` (USD per million tokens) to get `cost`:

```ts
Eval.create({
  // …
  pricing: {
    "gpt-5.4": { input: 1.25, cachedInput: 0.125, output: 10 },
  },
});
```

A key also prices the model ids it's a prefix of (`gpt-5.4` prices `gpt-5.4-2026-03-05`), and the longest matching key wins. Models without a price are listed in `totals.unpriced`.

The same meter is available on its own:

```ts
import { measureUsage } from "gemi/ai";

const { value, usage, byModel } = await measureUsage(() => agent.stream(params).result());
```

Meters nest, and concurrent meters don't see each other's calls. Work that `fn` started and didn't wait for counts only if it finishes before `fn` returns.

## Comparing with a baseline

```ts
import { readFileSync, writeFileSync } from "node:fs";

const report = await suite.run();
const baseline = JSON.parse(readFileSync("evals/questions.json", "utf8"));
console.log(Eval.format(report, { baseline }));

const diff = Eval.compare(baseline, report);
if (diff.regressions.length > 0) process.exit(1);
writeFileSync("evals/questions.json", JSON.stringify(report));
```

`Eval.compare` gives the change in pass rate and score in total, per case and per grader, for the ids both reports have. A change is `significant` when it is larger than 1.96 standard errors of the difference. A side with a single sample is never significant, and with two or more samples on each side and no spread at all, any change is. `regressions` and `improvements` list the significant changes as text. `Eval.format` marks them with `*`.

## Running options

`run({ only, runs, concurrency, signal, keepOutputs, onSample })`:

- `only` runs those case ids; an unknown id throws.
- `runs` and `concurrency` override the eval's own.
- `signal` stops starting new samples.
- `onSample(sample)` is called as each sample is graded, to print rows while the eval runs.

The report keeps the samples in case order whatever the concurrency.

## What it doesn't do

It has no CLI flags (read `--runs` and `--only` with `parseArgs` and pass them to `run`), and it doesn't store artifacts such as screenshots: write those from your task.
