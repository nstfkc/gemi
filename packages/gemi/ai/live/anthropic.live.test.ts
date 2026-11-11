/**
 * `AnthropicProvider` against the real Messages API. Opt-in: it runs only when
 * `ANTHROPIC_API_KEY` is set (`ANTHROPIC_LIVE_MODEL` picks the model, default
 * `claude-haiku-5-5`, the cheapest), and otherwise announces that it did not,
 * with a passing test, for the reason `live.test.ts` gives.
 *
 * The offline tests drive hand-written fixtures; this is what checks them
 * against the API. The thinking test is the one that matters most: a signature
 * that does not round-trip is a 400 on the second step, which no fixture can
 * show.
 */
process.env.SECRET ??= "ai-live-test-secret";

import { describe, expect, test } from "vitest";
import { Agent, AgentTool } from "../Agent";
import { AnthropicProvider } from "../AgentProvider";
import { s } from "../Schema";
import type { AgentMessage } from "../types";

const configured = Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = process.env.ANTHROPIC_LIVE_MODEL ?? "claude-haiku-5-5";
const TIMEOUT = 240_000;
const STOCK = 9182;

const textOf = (message: AgentMessage | undefined) =>
  (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

if (!configured) {
  describe("live anthropic (skipped)", () => {
    test("SKIPPED — set ANTHROPIC_API_KEY to run the live Anthropic suite", () => {
      console.warn(
        "\n  ⚠  Live Anthropic agent tests did NOT run.\n" +
          "     Set ANTHROPIC_API_KEY to exercise AnthropicProvider against the real\n" +
          "     Messages API. Everything else in ai/ runs offline.\n",
      );
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    });
  });
}

(configured ? describe : describe.skip)(`live anthropic — ${MODEL}`, () => {
  test(
    "a plain text run",
    async () => {
      const agent = Agent.create({
        name: "greeter",
        instructions: "Answer with a single word and no punctuation.",
        provider: AnthropicProvider.model(MODEL),
      });
      const result = await agent
        .stream({ messages: [], turn: { text: "What is the capital of France?" } })
        .result();
      expect(result.finishReason).toBe("stop");
      expect(textOf(result.messages.at(-1))).toMatch(/paris/i);
      expect(result.usage.totalTokens).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    "a tool call with thinking on, the signature sent back on the next step",
    async () => {
      const called: string[] = [];
      const agent = Agent.create({
        name: "warehouse",
        instructions: "You have no stock figures of your own. Use checkStock, then state the number.",
        provider: AnthropicProvider.model(MODEL),
        reasoning: "low",
        maxSteps: 4,
        tools: [
          AgentTool.create({
            name: "checkStock",
            description: "How many units of one SKU are in the warehouse",
            inputSchema: s.object({ sku: s.string() }),
            outputSchema: s.object({ units: s.number() }),
            execute: async (input) => {
              called.push(input.sku);
              return { units: STOCK };
            },
          }),
        ],
      });
      const result = await agent
        .stream({ messages: [], turn: { text: "How many units of AB-1 are in stock?" } })
        .result();
      expect(called).toEqual(["AB-1"]);
      expect(result.finishReason).toBe("stop");
      expect(textOf(result.messages.at(-1)).replace(/[,.\s]/g, "")).toContain(String(STOCK));
    },
    TIMEOUT,
  );

  test(
    "structured output",
    async () => {
      const agent = Agent.create({
        name: "classifier",
        instructions: "Classify the message.",
        provider: AnthropicProvider.model(MODEL),
        output: s.object({
          sentiment: s.enum(["positive", "neutral", "negative"]),
          topics: s.array(s.string()),
        }),
      });
      const result = await agent
        .stream({
          messages: [],
          turn: { text: "The invoice arrived late again and support never replied." },
        })
        .result();
      expect(result.output).toMatchObject({ sentiment: "negative" });
    },
    TIMEOUT,
  );
});
