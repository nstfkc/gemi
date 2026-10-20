# AI Skills

A skill is instructions an agent can load when it needs them. Instead of putting every guide into the system prompt, where it costs its tokens on every request, you give the agent skills. The model sees each skill's name and description and loads the body only when the task calls for it.

```ts
import { Agent, Skill } from "gemi/ai";

const refundPolicy = Skill.create({
  name: "refund-policy",
  description: "How refunds are decided. Load before answering a refund request.",
  // A string, or a function that is called only when the model loads the skill.
  instructions: () => Bun.file("app/agents/skills/refunds.md").text(),
  // Optional: files appended after the instructions, relative to the app root.
  files: ["app/agents/skills/refund-examples.md"],
});

export const supportAgent = Agent.create({
  name: "support",
  provider,
  instructions: "You answer customer questions.",
  skills: [refundPolicy],
});
```

## How it works

- Each skill becomes a tool without parameters in the reserved `skills` namespace. The tool's description is the skill's, and its result is the instructions followed by each file.
- Only names and descriptions are sent with every request. A body is read when the model loads the skill, not at startup, so a large skill costs nothing until it is used.
- A file that can't be read is reported to the model as `(could not be read: …)` instead of failing the run.
- Skills and tools share one set of names: two with the same name throw at `Agent.create`. The namespace name `skills` is reserved, so your own `ToolNamespace` can't be called that.
- The client sees a skill load as a tool part named after the skill.

## Skills for one run

Sometimes the skills depend on the request rather than on the agent: a design agent shared by every page, where each page has its own designer's pack. Pass them to that run with `skills` on `Agent.stream`. They're added to the agent's own skills in the same namespace, for that run only.

```ts
const run = designAgent.stream({
  messages,
  turn,
  skills: page.packs.map((pack) =>
    Skill.create({
      name: pack.slug,
      description: pack.summary,
      instructions: () => loadPackBody(pack.id),
    }),
  ),
});
```

A plain `{ name, description, instructions, files? }` object works as well as a `Skill`.

In an `AgentController`, answer them from `skills()`, which is called once per turn after `authorizeRequest()`, beside `instructions()`:

```ts
export class DesignChatController extends AgentController<typeof designAgent, { pageId: string }> {
  agent = designAgent;

  protected async skills(req, { body }) {
    // pageId was checked in authorizeRequest(): body is client-controlled.
    const page = await Page.find(body.pageId);
    return page.packs.map((pack) =>
      Skill.create({ name: pack.slug, description: pack.summary, instructions: () => pack.body() }),
    );
  }
}
```

It can also be shared through [`hooks`](./ai-controller-hooks.md) as `skills`. Answer nothing, or an empty list, for no extra skills.

What to know:

- **Nothing outlives the run.** The agent's next run sees only its own skills plus whatever that run is given. A turn that should keep a pack must be given it again (`skills()` runs on every turn).
- **Names can't clash.** A run's skill whose name is already one of the agent's tools or skills, or appears twice in the list, throws from `Agent.stream` (in a controller, the turn fails). Prefix pack names if they come from user data.
- **Sub-agents don't inherit them.** A sub-run started with `ctx.runAgent` gets its own agent's skills only.
- **Ordering.** The run's skills come after the agent's in the `skills` namespace, so the agent's part of the tool list stays the same from run to run.

## Skills and summaries

With [`contextWindow.compact`](./ai-context-window.md), a skill loaded in the turns being summarised is folded into the summary as `[loaded the skill "name"]`, without its body. The body is instructions the model can load again, not something that happened in the conversation, and a run's own skill may not exist on a later turn. A load is recognised by its name being one of the summarising run's skills, or by the provider reporting the call through the `skills` namespace.

## See also

- [AI Controller Hooks](./ai-controller-hooks.md): sharing `skills()` across controllers.
- [AI Context Window](./ai-context-window.md): summaries of older turns.
