// Compiled with `strict: true` by `eval/Eval.test.ts`, because that is how an
// app compiles it and the package's own config is not strict: under
// `strictFunctionTypes` a judge's typed `verdict` has to be assignable to the
// graders' union, which a `*.test-d.ts` in this package cannot see (#1007).
//
// Every line must compile except the ones marked `@ts-expect-error`, and
// those must fail.
import { Eval, OpenAIProvider, s } from "gemi/ai";

const provider = OpenAIProvider.model("gpt-5.4");

// The issue's example, as written.
export const fromKit = Eval.create({
  name: "x",
  cases: [{ id: "a", input: { ask: "q" } }],
  task: async (input) => ({ reply: input.ask }),
  graders: ({ judge }) => ({
    answered: (out) => out.reply !== "",
    j: judge({
      provider,
      prompt: (out) => out.reply,
      output: s.object({ ok: s.boolean() }),
      verdict: (v) => v.ok,
    }),
  }),
});

// A judge made with `Eval.judge`, outside the call, with its types given.
type Input = { ask: string };
type Output = { reply: string };
const standalone = Eval.judge<Input, Output, ReturnType<typeof okSchema>>({
  provider,
  prompt: (out, { input }) => `${input.ask}: ${out.reply}`,
  output: okSchema(),
  verdict: (judgment) => ({ pass: judgment.ok, note: judgment.reason }),
});
function okSchema() {
  return s.object({ ok: s.boolean(), reason: s.string() });
}
export const fromStatic = Eval.create({
  name: "y",
  cases: [{ id: "a", input: { ask: "q" } }],
  task: async (input): Promise<Output> => ({ reply: input.ask }),
  graders: { standalone, plain: (out) => out.reply.length > 0 },
});

// A record of graders holding only a judge made elsewhere: nothing in it is
// context-sensitive, so it used to be checked before the task's output was
// inferred, against `unknown`.
export const onlyStandalone = Eval.create({
  name: "w",
  cases: [{ id: "a", input: { ask: "q" } }],
  task: async (input) => ({ reply: input.ask }),
  graders: { standalone },
});

// What must still fail.
Eval.create({
  name: "z",
  cases: [{ id: "a", input: { ask: "q" } }],
  task: async (input) => ({ reply: input.ask }),
  graders: ({ judge }) => ({
    j: judge({
      provider,
      prompt: (out) => out.reply,
      output: s.object({ ok: s.boolean() }),
      // @ts-expect-error — the judgment has no `missing`
      verdict: (v) => v.missing,
    }),
    // @ts-expect-error — the output has no `nope`
    wrong: (out) => out.nope,
  }),
});
