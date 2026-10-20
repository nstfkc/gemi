// `./helpers` in docs/ai-evals.md's first example.
export async function askSiteAgent(ask: string): Promise<{ reply: string; calls: string[] }> {
  return { reply: ask, calls: [] };
}
