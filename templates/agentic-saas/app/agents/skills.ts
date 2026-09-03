import { Skill } from "gemi/ai";

/**
 * The refund policy, as instructions the model goes and fetches rather than
 * instructions it is handed.
 *
 * Pasting this document into the agent's `instructions` would work and would be
 * worse every month: it costs its full length on every request, including the
 * overwhelming majority that are about where a parcel is. As a skill it is
 * lowered to a zero-parameter tool in the reserved `skills` namespace, so what
 * the prompt carries is the one-line description below and the body arrives
 * only on a turn where a refund is genuinely on the table.
 *
 * The description is therefore the load-bearing part. It is the only thing the
 * model reads when deciding whether to open the document, so it names the
 * situations the document settles — a description like "refund policy" leaves
 * the model to guess whether declining a request counts.
 */
export const refundPolicySkill = Skill.create({
  name: "refund-policy",
  description:
    "When a refund may be issued, the windows it has to fall inside, what to do when it falls " +
    "outside one, and the wording to use when declining a request",
  // A thunk rather than a string: the file is read the first time the model
  // loads the skill, which keeps a document that grows to ten pages off the
  // startup path and out of the memory of every process that never serves a
  // refund. The path is relative to the app root, where the server starts.
  instructions: () => Bun.file("./app/skills/refund-policy.md").text(),
});
