// A real `AgentController` for the Swift client's end-to-end tests.
//
// The unit tests hold `ChatSession` to what the web hook sends, as read off
// `useChat.tsx`; this holds it to what the server actually accepts. Every
// route is the controller's own — request parsing, signing, the tool loop,
// the SSE encoding — and only the model is scripted, by the last thing the
// user said:
//
//   "hello"     answers in two deltas
//   "charge"    calls `charge`, which needs approval, then reports the outcome
//   "ask"       calls `ask`, then repeats the answer back
//   "count"     calls `count`, which yields three progress entries
//   "slow"      streams for ten seconds, for `stop()`
//
//   bun packages/gemi-swift/e2e/server.ts [port]
//
// then `GEMI_E2E_URL=http://127.0.0.1:<port> swift test` at the repo root.
process.env.SECRET ??= "gemi-swift-e2e-secret";

import { Agent, AgentTool } from "../../gemi/ai/Agent";
import { AgentController, MemoryAgentStore } from "../../gemi/ai/AgentController";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderStreamParams,
} from "../../gemi/ai/AgentProvider";
import { s } from "../../gemi/ai/Schema";
import type { AgentMessage } from "../../gemi/ai/types";
import { HttpRequest } from "../../gemi/http/HttpRequest";

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const finish: ProviderEvent = { type: "finish", reason: "stop", usage };

function lastUserText(messages: AgentMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    return { text: text.join(""), after: messages.slice(i + 1) };
  }
  return { text: "", after: [] as AgentMessage[] };
}

function resultsIn(messages: AgentMessage[]) {
  return messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "tool-result" ? [part] : [])),
  );
}

const scripted = {
  model: "scripted",
  capabilities: {
    reasoning: false,
    structuredOutput: true,
    fileInput: true,
    parallelToolCalls: true,
    toolSearch: false,
  },
  async upload(file: File) {
    return `file_${file.name}`;
  },
  normalizeError(error: unknown) {
    return { code: "provider_error", message: String(error), retryable: false };
  },
  stream(params: ProviderStreamParams) {
    const { text, after } = lastUserText(params.messages);
    const results = resultsIn(after);
    return (async function* (): AsyncGenerator<ProviderEvent> {
      const command = text.trim().split(/\s+/)[0];
      if (command === "hello") {
        yield { type: "text-delta", delta: "Hello " };
        yield { type: "text-delta", delta: "from gemi." };
      } else if (command === "charge" || command === "ask" || command === "count") {
        if (results.length === 0) {
          const args =
            command === "charge"
              ? { amountCents: 500 }
              : command === "ask"
                ? { question: "Which order?" }
                : { to: 3 };
          yield {
            type: "tool-call",
            toolCallId: `tc_${command}`,
            name: command,
            args: JSON.stringify(args),
          };
        } else {
          yield { type: "text-delta", delta: `Result: ${JSON.stringify(results[0])}` };
        }
      } else if (command === "slow") {
        for (let i = 0; i < 100; i++) {
          if (params.signal?.aborted) return;
          yield { type: "text-delta", delta: `${i} ` };
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } else {
        yield { type: "text-delta", delta: `Unscripted: ${text}` };
      }
      yield finish;
    })();
  },
} as unknown as AgentProvider;

export const e2eAgent = Agent.create({
  name: "e2e",
  provider: scripted,
  tools: [
    AgentTool.create({
      name: "charge",
      description: "Charge the customer",
      inputSchema: s.object({ amountCents: s.number() }),
      outputSchema: s.object({ receiptId: s.string() }),
      requiresApproval: true,
      execute: async (input) => ({ receiptId: `rc_${input.amountCents}` }),
    }),
    AgentTool.ask({
      name: "ask",
      description: "Ask the customer",
      outputSchema: s.object({ answer: s.string() }),
    }),
    AgentTool.create({
      name: "count",
      description: "Counts, yielding as it goes",
      inputSchema: s.object({ to: s.number() }),
      outputSchema: s.object({ counted: s.number() }),
      execute: async function* (input) {
        for (let n = 1; n <= input.to; n++) yield { n };
        return { counted: input.to };
      },
    }),
  ],
});

const store = new MemoryAgentStore();

class E2EController extends AgentController<typeof e2eAgent> {
  agent = e2eAgent;
  store = store;
}

const server = Bun.serve({
  port: Number(process.argv[2] ?? 0),
  hostname: "127.0.0.1",
  async fetch(raw) {
    const url = new URL(raw.url);
    const request = new HttpRequest(raw, {}, "api", url.pathname.replace(/^\/api/, ""));
    const controller = new E2EController();
    try {
      switch (url.pathname) {
        case "/api/support":
          return await controller.stream(request);
        case "/api/support/attach":
          return await controller.attach(request);
        case "/api/support/stop":
          return Response.json(await controller.stop(request));
        case "/api/support/files":
          return Response.json(await controller.upload(request));
        case "/api/support/threads":
          return Response.json(await store.createThread({}));
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (error) {
      console.error(error);
      return Response.json({ message: String(error) }, { status: 500 });
    }
  },
});

console.log(`ready ${server.port}`);
