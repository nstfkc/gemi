/**
 * Type-level tests for `Eval`: the input inferred from `cases`, the output from
 * `task`, and both reaching graders and judges without annotations. Run with
 * `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";
import { OpenAIProvider } from "../AgentProvider";
import { s } from "../Schema";
import { Eval, type EvalReport, type GraderContext } from "./Eval";

const provider = OpenAIProvider.model("gpt-5.4");
type Input = { ask: string; question: boolean };

describe("Eval.create", () => {
  test("graders see the case's input and the task's output", () => {
    const suite = Eval.create({
      name: "questions",
      cases: [
        { id: "moon", input: { ask: "Where is the moon?", question: true } },
        { id: "tall", input: { ask: "Make the hero taller", question: false } },
      ],
      task: async (input) => {
        expectTypeOf(input).toEqualTypeOf<Input>();
        return { reply: input.ask, calls: [] as string[] };
      },
      graders: ({ judge }) => ({
        answered: (out, ctx) => {
          expectTypeOf(out).toEqualTypeOf<{ reply: string; calls: string[] }>();
          expectTypeOf(ctx).toEqualTypeOf<GraderContext<Input>>();
          return out.reply !== "";
        },
        gate: { check: (out) => out.calls.length === 0, gate: true },
        offers: judge({
          provider,
          prompt: (out, { input }) => {
            expectTypeOf(out.reply).toEqualTypeOf<string>();
            expectTypeOf(input.question).toEqualTypeOf<boolean>();
            return out.reply;
          },
          output: s.object({ offers: s.boolean(), reason: s.string() }),
          verdict: (judgment) => {
            expectTypeOf(judgment).toEqualTypeOf<{ offers: boolean; reason: string }>();
            return { pass: judgment.offers, note: judgment.reason };
          },
        }),
      }),
    });
    type Report = Awaited<ReturnType<typeof suite.run>>;
    expectTypeOf<Report>().toEqualTypeOf<EvalReport<{ reply: string; calls: string[] }>>();
  });

  test("a plain record of checks needs no kit", () => {
    Eval.create({
      name: "plain",
      cases: [{ id: "a", input: { n: 1 } }],
      task: (input) => input.n * 2,
      graders: {
        even: (out, { input }) => {
          expectTypeOf(out).toEqualTypeOf<number>();
          expectTypeOf(input).toEqualTypeOf<{ n: number }>();
          return out % 2 === 0;
        },
      },
    });
  });

  test("a grader typed against another output is refused", () => {
    // The two disagree about the output, so one of them is reported: an
    // annotated grader takes part in inference (#1007), so it is the task.
    Eval.create({
      name: "x",
      cases: [{ id: "a", input: 1 }],
      // @ts-expect-error -- the grader reads a number, the task makes a string
      task: () => "text",
      graders: {
        wrong: (out: number) => out > 1,
      },
    });
  });
});
