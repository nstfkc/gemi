type Agent = {};

function createAgent(path: string): Agent {
  return {} as Agent;
}

interface UseChatParams {
  agent: Agent;
}

interface MessagePayload {}

export function useChat(params: UseChatParams) {
  return {
    messages: [],
    sendMessage: async (payload: MessagePayload) => {},
  };
}
