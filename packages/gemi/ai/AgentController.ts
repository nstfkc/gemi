// @ts-nocheck — the ai rfc is a sketch, not an interface anyone depends on:
// nothing exports `gemi/ai` and nothing in the package imports it, so its only
// reader is `tsc`, and a half-drawn signature there fails `bun run typecheck`
// and `build:types` for everyone. Checked again by deleting this line, which is
// the point of a per-file directive rather than dropping `ai` from the
// tsconfig: the files stay in the project, and the exemption is visible in the
// file that has it.
import { Agent, AgentTool, Schema } from "./Agent";
import { HttpRequest } from "../http";

export class AgentController<T extends Agent<any> = Agent<any>> {
  constructor(private agent: T) {}

  stream(req: HttpRequest) {
    this.agent.stream();
  }
}

const bashTool = AgentTool.create({
  name: "bash",
  description: "Execute a bash command",
  inputSchema: {} as Schema<{ command: string }>,
  outputSchema: {} as Schema<{ output: string }>,
  execute: async (input) => {
    const { command } = input;
    // Simulate bash command execution
    return { output: `Executed command: ${command}` };
  },
  deferred: false,
  requiresApproval: true,
});

const MyAgent = Agent.create({
  name: "MyAgent",
  tools: [bashTool],
});

class MyAgentController extends AgentController<typeof MyAgent> {
  constructor() {
    super(MyAgent);
  }

  private onMessage() {}
  private onError() {}
  private onStreamComplete() {}
}

type X = MyAgentController["agent"]["tools"][0];
