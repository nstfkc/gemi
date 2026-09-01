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
