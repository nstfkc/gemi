// `./question-evals` in docs/ai-evals.md's baseline example.
import { Eval } from "gemi/ai";

export const questions = Eval.create({
  name: "questions",
  cases: [{ id: "moon", input: { ask: "Where is the moon?" } }],
  task: async (input) => ({ reply: input.ask }),
  graders: { answered: (out) => out.reply !== "" },
});
