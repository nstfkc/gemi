// @ts-nocheck — the ai rfc is a sketch, not an interface anyone depends on:
// nothing exports `gemi/ai` and nothing in the package imports it, so its only
// reader is `tsc`, and a half-drawn signature there fails `bun run typecheck`
// and `build:types` for everyone. Checked again by deleting this line, which is
// the point of a per-file directive rather than dropping `ai` from the
// tsconfig: the files stay in the project, and the exemption is visible in the
// file that has it.
export type Schema<T> = {};

interface IAgentTool<T, U> {
  name: string;
  description: string;
  inputSchema: Schema<T>;
  outputSchema: Schema<U>;
  execute: (input: T) => Promise<U> | AsyncGenerator<U>;
  deferred: boolean;
  requiresApproval: boolean;
}

export class AgentTool<T, U> implements IAgentTool<T, U> {
  name: string = "";
  description = "";
  inputSchema = {} as Schema<T>;
  outputSchema = {} as Schema<U>;
  execute = (_input: T) => Promise.resolve({} as U);
  deferred = true;
  requiresApproval = true;
  skipped = false;

  static create<T, U>(params: IAgentTool<T, U>): AgentTool<T, U> {
    const tool = new AgentTool<T, U>();
    tool.name = params.name;
    tool.description = params.description;
    tool.inputSchema = params.inputSchema;
    tool.outputSchema = params.outputSchema;
    tool.execute = params.execute as any;
    tool.deferred = params.deferred;
    tool.requiresApproval = params.requiresApproval;
    return tool;
  }
}

const grepTool = AgentTool.create({
  name: "grep",
  description: "Search for a pattern in a file",
  inputSchema: {} as Schema<{ pattern: string; filePath: string }>,
  outputSchema: {} as Schema<{ matches: string[] }>,
  execute: async (input) => {
    const { pattern, filePath } = input;
    // Simulate grep operation
    return { matches: [`Found ${pattern} in ${filePath}`] };
  },
  deferred: false,
  requiresApproval: false,
});

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

interface CreateAgentParams<T extends AgentTool<any, any>[]> {
  name: string;
  tools: T;
}

export class Agent<const T extends AgentTool<any, any>[] = AgentTool<any, any>[]> {
  tools: T;
  skills: any[];

  static create<const T extends AgentTool<any, any>[]>(params: CreateAgentParams<T>): Agent<T> {
    const agent = new Agent<T>();
    agent.tools = params.tools;
    return agent;
  }

  stream() {}
}

const mainAgent = Agent.create({
  name: "MainAgent",
  tools: [grepTool, bashTool],
});

type MainAgent = typeof mainAgent;

type X = MainAgent["tools"][0];
