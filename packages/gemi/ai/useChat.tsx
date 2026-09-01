// @ts-nocheck — the ai rfc is a sketch, not an interface anyone depends on:
// nothing exports `gemi/ai` and nothing in the package imports it, so its only
// reader is `tsc`, and a half-drawn signature there fails `bun run typecheck`
// and `build:types` for everyone. Checked again by deleting this line, which is
// the point of a per-file directive rather than dropping `ai` from the
// tsconfig: the files stay in the project, and the exemption is visible in the
// file that has it.
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
