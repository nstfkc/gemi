interface UseChatParams {}

export function useChat(params: UseChatParams) {
  return {
    messages: [],
    sendMessage: async (message: string) => {},
  };
}
