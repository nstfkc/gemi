type AgentMessage = {};
interface Stream {}

interface StreamParams {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools?: any[];
  skills: any[];
  output: any;
  reasoning: "low" | "medium" | "high";
}

export class AgentProvider {
  static models() {}

  stream(params: StreamParams): Stream {
    return {} as Stream;
  }

  upload(file: File): Promise<string> {
    return Promise.resolve("file-id");
  }
}

export class OpenAIProvider extends AgentProvider {
  model: string;

  constructor(model: string = "gpt-5.4") {
    super();
    this.model = model;
  }

  static model(): OpenAIProvider {
    return new OpenAIProvider();
  }

  generate(params: GenerateParams) {}
}
