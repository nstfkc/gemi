/**
 * The suite that talks to a real model.
 *
 * WHY THIS EXISTS. Every other test in `ai/` drives a scripted provider or a
 * recorded stream, which is the right default — they are fast, offline and
 * deterministic. What they cannot do is notice that the thing being scripted is
 * not what the API sends. The deferred-tool test below is the case in point:
 * `tool_search_output.tools` is an array of *namespaces* containing functions,
 * the parser used to read the top-level `name` off it and report `["crm"]`, and
 * every fixture in the repo agreed with the parser because the fixtures were
 * written from the same misreading. Only the API disagrees.
 *
 * HOW IT IS GATED, and why it is gated this way. The repository already has an
 * answer for environment-dependent suites — `POSTGRES_URL ? describe :
 * describe.skip` plus a *passing* test that warns — and the reasoning is
 * written up in `orm/postgres-suite-selection.test.ts`: three suites once ran
 * in neither CI job and nothing said so. `describe.skip` is silent, and a
 * silently skipped suite reads exactly like a passing one. So the same idiom is
 * used here, and the announcement below is not decoration: it is the only thing
 * standing between "the live tests are green" and "the live tests did not run".
 *
 * A contributor with no key gets two passing announcements and no failures.
 * `bun run test:live` runs it deliberately, and `vitest -t openai` / `-t azure`
 * runs one provider — every suite name carries its provider for that reason.
 *
 * NO KEY MATERIAL, ANYWHERE. Nothing here reads a credential by value; the
 * providers pick their own out of the environment. Load them however you like —
 * `set -a && . packages/.env && set +a` is the usual one — and note that the
 * fixtures this suite would otherwise tempt you to record belong in
 * `providers/__fixtures__`, which has a test asserting no file in it carries a
 * key.
 *
 * COST. Prompts are short, `max_output_tokens` is capped at 2000 by
 * `RecordingProvider`, and every agent has a low `maxSteps`. A full run of both
 * providers is a few cents.
 */
process.env.SECRET ??= "ai-live-test-secret";

import { describe, expect, test } from "vitest";
import { Agent, AgentTool, ToolNamespace } from "../Agent";
import { applyFrame, initialChatState } from "../client/reducer";
import { toResponsesInput } from "../providers/request";
import { s } from "../Schema";
import type { AgentMessage, AgentStreamEvent, PendingToolCall } from "../types";
import {
  AZURE_RESOURCE_VARS,
  azureConfigured,
  collectFrames,
  configuredFor,
  lastOf,
  LIVE_AZURE_DEPLOYMENT,
  LIVE_MODEL,
  openaiConfigured,
  partsOf,
  req,
  TARGETS,
  textOf,
  transcriptText,
  withoutDigitGrouping,
  type LiveTarget,
} from "./harness";

/** A model call can take a while at `reasoning: "high"`, and a nested run is
 *  several of them in series. */
const TIMEOUT = 240_000;

// --- the announcement -----------------------------------------------------
//
// Deliberately a passing test rather than `test.skip`, and deliberately loud:
// see the header. The wording matches the four Postgres suites that already do
// this, because a second dialect of the same message is a second thing to
// recognize.

if (!openaiConfigured) {
  describe("live openai (skipped)", () => {
    test("SKIPPED — set OPENAI_API_KEY to run the live OpenAI suite", () => {
      console.warn(
        "\n  ⚠  Live OpenAI agent tests did NOT run.\n" +
          "     Set OPENAI_API_KEY to exercise the module against the real\n" +
          "     Responses API. Everything else in ai/ runs offline.\n",
      );
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
    });
  });
}

if (!azureConfigured) {
  describe("live azure (skipped)", () => {
    test("SKIPPED — set AZURE_OPENAI_API_KEY and a resource to run the live Azure suite", () => {
      console.warn(
        "\n  ⚠  Live Azure agent tests did NOT run.\n" +
          `     Set AZURE_OPENAI_API_KEY and one of ${AZURE_RESOURCE_VARS.join(", ")}.\n` +
          "     Azure is not a formality here: it sends content_filters OpenAI\n" +
          "     does not, and its Responses path differs — see AgentProvider.\n",
      );
      // One of the two halves is missing; saying which would mean printing an
      // env var this file has no business reading.
      expect(azureConfigured).toBe(false);
    });
  });
}

// --- fixtures the battery builds per provider ----------------------------

/** A number no model will produce on its own, so "the tool's answer reached the
 *  final message" is checkable by looking for it. */
const POPULATION = 7413;
const STOCK = 9182;

function inventoryTool(log: string[]) {
  return AgentTool.create({
    name: "checkStock",
    description: "How many units of one SKU are in the warehouse",
    inputSchema: s.object({ sku: s.string().describe("A SKU like AB-1") }),
    outputSchema: s.object({ units: s.number() }),
    execute: async (input) => {
      log.push(input.sku);
      return { units: input.sku === "AB-1" ? STOCK : STOCK + 1 };
    },
  });
}

function populationTool(log: string[]) {
  return AgentTool.create({
    name: "lookupPopulation",
    description: "The population of a town in the company's private records",
    inputSchema: s.object({ town: s.string() }),
    outputSchema: s.object({ people: s.number() }),
    execute: async (input) => {
      log.push(input.town);
      return { people: POPULATION };
    },
  });
}

function refundTool(log: string[]) {
  return AgentTool.create({
    name: "issueRefund",
    description: "Refund one order in full",
    inputSchema: s.object({ orderId: s.string() }),
    outputSchema: s.object({ refundId: s.string() }),
    requiresApproval: true,
    execute: async (input) => {
      log.push(input.orderId);
      return { refundId: `rf_${input.orderId}` };
    },
  });
}

// --- the battery ----------------------------------------------------------

function battery(target: LiveTarget) {
  const RUN = configuredFor(target.label) ? describe : describe.skip;
  const model = target.label === "openai" ? LIVE_MODEL : LIVE_AZURE_DEPLOYMENT;

  RUN(`live ${target.label} — ${model}`, () => {
    test(
      "a plain text run",
      async () => {
        const provider = target.provider();
        const agent = Agent.create({
          name: "greeter",
          instructions: "Answer with a single word and no punctuation.",
          provider,
        });
        const run = agent.stream({
          messages: [],
          req,
          turn: { text: "What is the capital of France?" },
        });
        const events: AgentStreamEvent[] = [];
        for await (const event of run) events.push(event);
        const result = await run.result();

        expect(result.finishReason).toBe("stop");
        expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(textOf(lastOf(result.messages))).toMatch(/paris/i);
        // A run that reported no tokens has not talked to anything.
        expect(result.usage.totalTokens).toBeGreaterThan(0);
        expect(result.usage).toEqual(provider.spent());
        expect(events[0]).toMatchObject({ type: "run-start" });
        expect(lastOf(events)).toMatchObject({ type: "run-end", finishReason: "stop" });
        expect(events.some((event) => event.type === "text-delta")).toBe(true);
      },
      TIMEOUT,
    );

    test(
      "a tool call, and its result feeding the final answer",
      async () => {
        const called: string[] = [];
        const provider = target.provider();
        const agent = Agent.create({
          name: "warehouse",
          instructions:
            "You have no stock figures of your own. Use checkStock, then state the number.",
          provider,
          tools: [inventoryTool(called)],
          maxSteps: 4,
        });
        const result = await agent
          .stream({
            messages: [],
            req,
            turn: { text: "How many units of AB-1 are in stock?" },
          })
          .result();

        expect(called).toEqual(["AB-1"]);
        const calls = partsOf(result.messages, "tool-call");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ name: "checkStock", input: { sku: "AB-1" } });
        expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({
          status: "ok",
          output: { units: STOCK },
        });
        // The claim that matters: the tool's answer, not the model's guess,
        // is what the user reads. `9182` is not a number a model invents.
        expect(withoutDigitGrouping(textOf(lastOf(result.messages)))).toContain(String(STOCK));
        expect(result.finishReason).toBe("stop");
        // Two model calls: one to ask for the tool, one to answer with it.
        expect(provider.calls).toBe(2);
      },
      TIMEOUT,
    );

    test(
      "parallel tool calls in one step",
      async () => {
        const called: string[] = [];
        const provider = target.provider();
        const agent = Agent.create({
          name: "warehouse",
          instructions:
            "You have no stock figures of your own. When asked about several SKUs, call " +
            "checkStock once for each of them in the SAME turn, never one turn at a time.",
          provider,
          tools: [inventoryTool(called)],
          maxSteps: 4,
        });
        const result = await agent
          .stream({
            messages: [],
            req,
            turn: { text: "Stock for AB-1 and for CD-2?" },
          })
          .result();

        expect(called.sort()).toEqual(["AB-1", "CD-2"]);
        const calls = partsOf(result.messages, "tool-call");
        expect(calls).toHaveLength(2);
        // Parallel means one assistant message holding both, which is also what
        // makes it one model call rather than two.
        const messagesWithCalls = result.messages.filter((message) =>
          message.content.some((part) => part.type === "tool-call"),
        );
        expect(messagesWithCalls).toHaveLength(1);
        expect(provider.calls).toBe(2);
        expect(partsOf(result.messages, "tool-result")).toHaveLength(2);
      },
      TIMEOUT,
    );

    test(
      "structured output against a schema built with `s`",
      async () => {
        const schema = s.object({
          sentiment: s.enum(["positive", "neutral", "negative"]),
          topics: s.array(s.string()),
        });
        const provider = target.provider();
        const agent = Agent.create({
          name: "classifier",
          instructions: "Classify the message.",
          provider,
          output: schema,
        });
        const run = agent.stream({
          messages: [],
          req,
          turn: { text: "The invoice arrived late again and support never replied." },
        });
        const events: AgentStreamEvent[] = [];
        for await (const event of run) events.push(event);
        const result = await run.result();

        expect(result.finishReason).toBe("stop");
        // The point of the assertion: the schema that built the request is the
        // one that reads the answer, and it accepts it.
        const parsed = schema.safeParse(result.output);
        expect(parsed.ok === true ? [] : parsed.errors).toEqual([]);
        expect(result.output).toMatchObject({ sentiment: "negative" });
        expect(Array.isArray((result.output as any).topics)).toBe(true);
        // Strict mode: nothing outside the schema comes back.
        expect(Object.keys(result.output as any).sort()).toEqual(["sentiment", "topics"]);

        const output = partsOf(result.messages, "output");
        expect(output).toHaveLength(1);
        expect(output[0].value).toEqual(result.output);
        // The JSON arrived as a stream, which is what `output-delta` is for.
        expect(events.filter((event) => event.type === "output-delta").length).toBeGreaterThan(0);
      },
      TIMEOUT,
    );

    test(
      "a deferred tool behind a namespace, and what tool search reports",
      async () => {
        const provider = target.provider();
        const listOrders = AgentTool.create({
          name: "listOrders",
          description: "List a customer's recent order ids",
          inputSchema: s.object({ customerId: s.string() }),
          outputSchema: s.object({ orderIds: s.array(s.string()) }),
          execute: async () => ({ orderIds: ["ord_1"] }),
        });
        const getOrder = AgentTool.create({
          name: "getOrder",
          description: "Read one order's total, in cents",
          inputSchema: s.object({ orderId: s.string() }),
          outputSchema: s.object({ totalCents: s.number() }),
          execute: async () => ({ totalCents: 4200 }),
        });
        const crm = ToolNamespace.create({
          name: "crm",
          description: "Customer records, orders and refunds",
          deferred: true,
          tools: [listOrders, getOrder],
        });
        const agent = Agent.create({
          name: "support",
          instructions: "Use the crm tools. Answer with the number of cents only.",
          provider,
          tools: [crm],
          maxSteps: 4,
        });
        const run = agent.stream({
          messages: [],
          req,
          turn: { text: "What is the total on order ord_1?" },
        });
        const events: AgentStreamEvent[] = [];
        for await (const event of run) events.push(event);
        const result = await run.result();

        // THE BUG THIS SUITE WAS WRITTEN FOR. The search results are a tree of
        // namespaces holding functions; reading `name` off the top level yields
        // the namespace, so this used to report `loaded: ["crm"]` — the one
        // thing the user already knew. Every offline fixture agreed with it,
        // because the fixtures were written from the same misreading.
        const searches = events.filter((event) => event.type === "tool-search") as any[];
        expect(searches.length).toBeGreaterThan(0);
        const loaded = searches.flatMap((event) => event.loaded);
        expect(loaded).toContain("getOrder");
        expect(loaded).not.toContain("crm");

        // The parser knows both levels; `AgentStreamEvent` only carries one, so
        // the group is checked where it exists.
        const parsed = provider.events.filter((event) => event.type === "tool-search") as any[];
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.flatMap((event) => event.namespaces)).toEqual(["crm"]);

        // The RFC's open question, answered by the API rather than by us: a
        // namespaced call comes back with a FLAT name and the namespace beside
        // it, which is why `name` is still the registry key.
        const providerCalls = provider.events.filter(
          (event) => event.type === "tool-call",
        ) as any[];
        expect(providerCalls.length).toBeGreaterThan(0);
        expect(providerCalls[0].namespace).toBe("crm");
        expect(providerCalls[0].name).not.toContain(".");
        expect(["listOrders", "getOrder"]).toContain(providerCalls[0].name);

        expect(result.finishReason).toBe("stop");
        expect(transcriptText(result.messages)).toContain("4200");
      },
      TIMEOUT,
    );

    /**
     * WHETHER A MODEL REASONS IS THE MODEL'S BUSINESS, and it is the one thing
     * in this file that is genuinely nondeterministic: at `effort: "high"` on a
     * puzzle whose answer the tool call depends on, both providers emitted a
     * reasoning item on the first step five times out of six, and the sixth run
     * emitted none at all.
     *
     * So the RUN is retried until the model reasons before its last step. The
     * ASSERTIONS are not retried and are not relaxed — the loop below stops at
     * the first run that gives the round trip something to be about, and then
     * checks it. A run that never reasons in three attempts fails, loudly,
     * rather than passing vacuously.
     */
    async function reasoningRun() {
      const recorded: number[] = [];
      const provider = target.provider();
      const record = AgentTool.create({
        name: "recordAnswer",
        description: "Record how many dollars are genuinely unaccounted for",
        inputSchema: s.object({ dollars: s.number() }),
        outputSchema: s.object({ saved: s.boolean() }),
        execute: async (input) => {
          recorded.push(input.dollars);
          return { saved: true };
        },
      });
      const agent = Agent.create({
        name: "thinker",
        instructions: "Think it through before you answer.",
        provider,
        tools: [record],
        reasoning: "high",
        maxSteps: 4,
      });
      const result = await agent
        .stream({
          messages: [],
          req,
          turn: {
            text:
              "Three people pay 30 for a room; the clerk refunds 5, the bellhop keeps 2 and " +
              "returns 1 each. Work out where the missing dollar goes, call recordAnswer with " +
              "how many dollars are genuinely unaccounted for, then explain in one sentence.",
          },
        })
        .result();

      // What each model call after the first actually put on the wire, beside
      // the reasoning it was handed. This pair is the round trip.
      const steps = provider.requests.slice(1).map((request) => ({
        held: partsOf(request.messages, "reasoning").filter((part: any) => part.id),
        sent: toResponsesInput(request.messages, provider.capabilities).filter(
          (item) => item.type === "reasoning",
        ),
      }));
      return { provider, result, recorded, steps };
    }

    test(
      "reasoning survives a round trip across two steps",
      async () => {
        let run = await reasoningRun();
        for (
          let attempt = 1;
          attempt < 3 && run.steps.every((step) => step.held.length === 0);
          attempt++
        ) {
          run = await reasoningRun();
        }

        expect(run.provider.calls).toBeGreaterThanOrEqual(2);
        expect(run.recorded).toHaveLength(1);

        const reasoning = partsOf(run.result.messages, "reasoning");
        expect(
          reasoning.length,
          "the model produced no reasoning in three attempts, so there was no round trip to check",
        ).toBeGreaterThan(0);
        // An id, because that is the API's handle on the stored reasoning and
        // `request.ts` drops an item without one rather than fabricating a
        // reference. Losing it is invisible in the transcript and shows up as a
        // cold prompt cache and a model that has forgotten its own argument —
        // which is exactly what this suite found the first time it ran.
        expect(reasoning[0].id).toMatch(/^rs_/);
        expect(reasoning[0].text.length).toBeGreaterThan(0);

        // THE ROUND TRIP. Every reasoning item a later step was handed is a
        // reasoning item that step sent, under the same id.
        expect(run.steps.some((step) => step.held.length > 0)).toBe(true);
        for (const step of run.steps) {
          expect(step.sent.map((item) => item.id).sort()).toEqual(
            step.held.map((part: any) => part.id).sort(),
          );
        }
      },
      TIMEOUT,
    );

    test(
      "an approval parks the run, and a second turn releases it",
      async () => {
        const refunded: string[] = [];
        const refund = refundTool(refunded);
        const first = target.provider();
        const agent = Agent.create({
          name: "billing",
          instructions: "Use issueRefund. Confirm with the refund id when it comes back.",
          provider: first,
          tools: [refund],
          maxSteps: 4,
        });
        const run = agent.stream({
          messages: [],
          req,
          turn: { text: "Refund order ord_7 in full." },
        });
        const events: AgentStreamEvent[] = [];
        for await (const event of run) events.push(event);
        const parked = await run.result();

        expect(parked.finishReason).toBe("awaiting-input");
        // Not run, and not run yet — the whole point of an approval.
        expect(refunded).toEqual([]);
        const awaiting = events.find((event) => event.type === "awaiting-input") as any;
        const pending = awaiting.pending as PendingToolCall[];
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          name: "issueRefund",
          kind: "approval",
          input: { orderId: "ord_7" },
        });
        expect(pending[0].signature.length).toBeGreaterThan(0);
        // Top level: no path. The nested test below is where a path appears.
        expect(pending[0].path).toBeUndefined();
        expect(partsOf(parked.messages, "tool-result")).toHaveLength(0);

        const second = target.provider();
        const resumed = await agent
          .stream({
            messages: parked.messages,
            req,
            provider: second,
            turn: {
              toolResults: [
                {
                  toolCallId: pending[0].toolCallId,
                  signature: pending[0].signature,
                  approve: true,
                },
              ],
            },
          })
          .result();

        expect(refunded).toEqual(["ord_7"]);
        expect(resumed.finishReason).toBe("stop");
        const results = partsOf(resumed.messages, "tool-result");
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          toolCallId: pending[0].toolCallId,
          status: "ok",
          output: { refundId: "rf_ord_7" },
        });
        expect(transcriptText(resumed.messages)).toContain("rf_ord_7");
      },
      TIMEOUT,
    );

    // --- the headline: a tool that runs another agent ----------------------

    /**
     * Built once and shared by the nesting test and the client-reducer test.
     *
     * Lazily rather than in a `beforeAll` so that skipping the reducer test
     * skips the model calls too, and so the two tests are not ordered against
     * each other — either one alone builds it.
     */
    let nested: Promise<Awaited<ReturnType<typeof buildNested>>> | undefined;
    const nestedFixture = () => (nested ??= buildNested());

    async function buildNested() {
      const towns: string[] = [];
      const subProvider = target.provider();
      const researcher = Agent.create({
        name: "researcher",
        instructions: "Use lookupPopulation. Answer with the number and nothing else.",
        provider: subProvider,
        tools: [populationTool(towns)],
        maxSteps: 4,
      });

      const delegate = AgentTool.create({
        name: "delegate",
        description: "Ask the research sub-agent one question",
        inputSchema: s.object({ question: s.string() }),
        outputSchema: s.object({ answer: s.string() }),
        execute: async (input, ctx) => {
          const sub = await ctx.runAgent(researcher, {
            prompt: input.question,
            label: "researching the town",
          });
          return { answer: textOf(lastOf(sub.messages)) };
        },
      });

      const parentProvider = target.provider();
      const lead = Agent.create({
        name: "lead",
        instructions:
          "You cannot look anything up. Use delegate for any question of fact, then " +
          "report what it said.",
        provider: parentProvider,
        tools: [delegate],
        maxSteps: 4,
      });

      const userText = "What is the population of Ashgrove Hollow?";
      const run = lead.stream({ messages: [], req, turn: { text: userText } });
      const { wire, live, done } = collectFrames(run);
      const result = await run.result();
      await done;
      return { result, wire, live, parentProvider, subProvider, towns, userText };
    }

    test(
      "a tool whose execute runs a sub-agent that calls a tool of its own",
      async () => {
        const { result, wire: frames, parentProvider, subProvider, towns } = await nestedFixture();

        expect(result.finishReason).toBe("stop");
        expect(towns.length).toBe(1);

        const call = partsOf(result.messages, "tool-call").find((part) => part.name === "delegate");
        expect(call).toBeDefined();
        expect(partsOf(result.messages, "tool-result")[0]).toMatchObject({ status: "ok" });
        // The sub-agent's tool's answer reached the parent's final message,
        // through the sub-agent's own answer and the parent tool's return.
        expect(withoutDigitGrouping(transcriptText(result.messages))).toContain(String(POPULATION));

        // THE NESTED TRANSCRIPT, on the parent's tool call.
        expect(call.nested).toHaveLength(1);
        const sub = call.nested[0];
        expect(sub).toMatchObject({
          agent: "researcher",
          label: "researching the town",
          finishReason: "stop",
        });
        expect(sub.usage.totalTokens).toBeGreaterThan(0);
        // It is an ordinary transcript, which is the entire design: the same
        // reducer and the same components render it.
        const subCalls = partsOf(sub.messages, "tool-call");
        expect(subCalls.map((part: any) => part.name)).toEqual(["lookupPopulation"]);
        expect(partsOf(sub.messages, "tool-result")[0]).toMatchObject({
          status: "ok",
          output: { people: POPULATION },
        });

        // NESTED EVENTS, IN THE PARENT'S SEQ. `/attach` replay and the frame
        // buffer both count in this sequence, so a nested event numbered
        // outside it would be a hole a reattaching client falls into.
        expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, at) => at + 1));
        const nestedFrames = frames.filter((frame) => frame.event.type === "nested-event");
        expect(nestedFrames.length).toBeGreaterThan(0);
        for (const frame of nestedFrames) {
          expect(frame.event).toMatchObject({
            toolCallId: call.toolCallId,
            runId: sub.runId,
            agent: "researcher",
            label: "researching the town",
          });
        }
        const inner = nestedFrames.map((frame) => (frame.event as any).event.type);
        expect(inner).toContain("run-start");
        expect(inner).toContain("tool-call");
        expect(inner).toContain("tool-result");
        expect(inner).toContain("run-end");

        const indexOf = (match: (event: any) => boolean) =>
          frames.findIndex((frame) => match(frame.event));
        const parentCall = indexOf(
          (event) => event.type === "tool-call" && event.part.toolCallId === call.toolCallId,
        );
        const parentResult = indexOf(
          (event) => event.type === "tool-result" && event.part.toolCallId === call.toolCallId,
        );
        const nestedPositions = frames
          .map((frame, at) => (frame.event.type === "nested-event" ? at : -1))
          .filter((at) => at >= 0);
        expect(Math.min(...nestedPositions)).toBeGreaterThan(parentCall);
        expect(Math.max(...nestedPositions)).toBeLessThan(parentResult);

        // USAGE ROLLED UP: the parent's total is every token both runs spent,
        // checked against what the two providers themselves reported.
        const spent = {
          inputTokens: parentProvider.spent().inputTokens + subProvider.spent().inputTokens,
          outputTokens: parentProvider.spent().outputTokens + subProvider.spent().outputTokens,
          totalTokens: parentProvider.spent().totalTokens + subProvider.spent().totalTokens,
        };
        expect(result.usage.inputTokens).toBe(spent.inputTokens);
        expect(result.usage.outputTokens).toBe(spent.outputTokens);
        expect(result.usage.totalTokens).toBe(spent.totalTokens);
        expect(subProvider.calls).toBeGreaterThanOrEqual(2);
      },
      TIMEOUT,
    );

    test(
      "a sub-agent's approval reaches the user, and the resumed tool does not redo its work",
      async () => {
        const towns: string[] = [];
        const refunded: string[] = [];
        const resumedFlags: boolean[] = [];

        const researchProvider = target.provider();
        const researcher = Agent.create({
          name: "researcher",
          instructions: "Use lookupPopulation. Answer with the number and nothing else.",
          provider: researchProvider,
          tools: [populationTool(towns)],
          maxSteps: 4,
        });

        const financeProvider = target.provider();
        const finance = Agent.create({
          name: "finance",
          instructions: "Use issueRefund for the order you are given, then confirm the refund id.",
          provider: financeProvider,
          tools: [refundTool(refunded)],
          maxSteps: 4,
        });

        const settle = AgentTool.create({
          name: "settle",
          description: "Look the town up and refund the order, using the two sub-agents",
          inputSchema: s.object({ orderId: s.string() }),
          outputSchema: s.object({ town: s.string(), refund: s.string() }),
          execute: async (input, ctx) => {
            resumedFlags.push(ctx.resumed);
            // Runs on turn one, and must be REPLAYED on turn two rather than
            // run again — the claim the call counts below exist to check.
            const looked = await ctx.runAgent(researcher, {
              prompt: "What is the population of Ashgrove Hollow?",
              label: "population",
            });
            // Escalates: its tool needs an approval only the user can give.
            const settled = await ctx.runAgent(finance, {
              prompt: `Refund order ${input.orderId}.`,
              label: "refund",
            });
            return {
              town: textOf(lastOf(looked.messages)),
              refund: textOf(lastOf(settled.messages)),
            };
          },
        });

        const parentProvider = target.provider();
        const lead = Agent.create({
          name: "lead",
          instructions: "Use settle for the order you are given, then report both answers.",
          provider: parentProvider,
          tools: [settle],
          maxSteps: 4,
        });

        const run = lead.stream({
          messages: [],
          req,
          turn: { text: "Settle order ord_7." },
        });
        const events: AgentStreamEvent[] = [];
        for await (const event of run) events.push(event);
        const parked = await run.result();

        // TURN ONE: the parent parks, holding the SUB-agent's question.
        expect(parked.finishReason).toBe("awaiting-input");
        const awaiting = events.find((event) => event.type === "awaiting-input") as any;
        const pending = awaiting.pending as PendingToolCall[];
        expect(pending).toHaveLength(1);
        const parentCall = partsOf(parked.messages, "tool-call").find(
          (part) => part.name === "settle",
        );
        expect(pending[0]).toMatchObject({
          name: "issueRefund",
          kind: "approval",
          input: { orderId: "ord_7" },
          // The address. The parent never made a call with this id, so the id
          // alone cannot say which tool to re-enter.
          path: [parentCall.toolCallId],
        });
        expect(refunded).toEqual([]);

        const researchCallsAfterTurnOne = researchProvider.calls;
        const financeCallsAfterTurnOne = financeProvider.calls;
        expect(researchCallsAfterTurnOne).toBeGreaterThanOrEqual(2);
        expect(towns).toHaveLength(1);
        expect(resumedFlags).toEqual([false]);
        // Both sub-runs are on the parent's tool call: one finished, one parked.
        expect(parentCall.nested).toHaveLength(2);
        expect(parentCall.nested[0]).toMatchObject({ agent: "researcher", finishReason: "stop" });
        expect(parentCall.nested[1]).toMatchObject({
          agent: "finance",
          finishReason: "awaiting-input",
        });

        // TURN TWO: the user approves, and the tool is re-entered from the top.
        const resumeProvider = target.provider();
        const resumed = await lead
          .stream({
            messages: parked.messages,
            req,
            provider: resumeProvider,
            turn: {
              toolResults: [
                {
                  toolCallId: pending[0].toolCallId,
                  signature: pending[0].signature,
                  path: pending[0].path,
                  approve: true,
                },
              ],
            },
          })
          .result();

        // THE PART THAT MATTERS. The tool body ran again — there is no way to
        // suspend an async generator across a turn — but the sub-run that had
        // already finished was replayed out of the transcript: no request, no
        // tool call, no second bill.
        expect(resumedFlags).toEqual([false, true]);
        expect(researchProvider.calls).toBe(researchCallsAfterTurnOne);
        expect(towns).toHaveLength(1);
        // The one that parked continued instead of restarting: it took further
        // steps, and its approval tool ran exactly once.
        expect(financeProvider.calls).toBeGreaterThan(financeCallsAfterTurnOne);
        expect(refunded).toEqual(["ord_7"]);

        expect(resumed.finishReason).toBe("stop");
        const result = partsOf(resumed.messages, "tool-result").find(
          (part) => part.toolCallId === parentCall.toolCallId,
        );
        expect(result).toMatchObject({ status: "ok" });
        expect(withoutDigitGrouping(result.output.town)).toContain(String(POPULATION));
        expect(result.output.refund).toContain("rf_ord_7");
      },
      TIMEOUT,
    );

    // --- the client half, against frames a model produced -------------------

    test(
      "the client reducer rebuilds the transcript a UI would render, nesting included",
      async () => {
        const { result, wire, live, userText } = await nestedFixture();

        // Seeded the way `useChat` seeds it: the user's own turn is authored in
        // the browser and never comes back on the stream.
        const seed: AgentMessage[] = [
          {
            id: "local_1",
            role: "user",
            content: [{ type: "text", text: userText }],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ];
        const now = "2026-01-01T00:00:00.000Z";
        const replay = (frames = wire, initial = initialChatState({ messages: seed })) =>
          frames.reduce((state, frame) => applyFrame(state, frame, now), initial);

        // `wire`, not the live frame objects: a `tool-call` frame carries its
        // part by reference and the part keeps being written to afterwards, so
        // the in-process objects arrive at the reducer with the nested
        // transcript already built. See `collectFrames`.
        const state = replay();

        expect(state.error).toBeNull();
        expect(state.pending).toEqual([]);
        expect(state.finishReason).toBe("stop");
        expect(state.messages.map((message) => message.role)).toEqual([
          "user",
          ...result.messages.slice(1).map((message) => message.role),
        ]);
        // The same ids and the same text the server produced — the client's
        // transcript is not a paraphrase of the run, it is the run.
        expect(state.messages.slice(1).map((message) => message.id)).toEqual(
          result.messages.slice(1).map((message) => message.id),
        );
        expect(transcriptText(state.messages.slice(1))).toBe(
          transcriptText(result.messages.slice(1)),
        );

        const call = partsOf(state.messages, "tool-call").find((part) => part.name === "delegate");
        expect(call).toBeDefined();
        expect(partsOf(state.messages, "tool-result")[0]).toMatchObject({ status: "ok" });

        // THE NESTED TRANSCRIPT, REBUILT BY THE SAME REDUCER RECURSING. The
        // client has never met these frames before: every earlier test of this
        // path fed it frames the client half wrote itself.
        expect(call.nested).toHaveLength(1);
        const sub = call.nested[0];
        expect(sub).toMatchObject({
          agent: "researcher",
          label: "researching the town",
          finishReason: "stop",
        });
        expect(partsOf(sub.messages, "tool-call").map((part: any) => part.name)).toEqual([
          "lookupPopulation",
        ]);
        expect(partsOf(sub.messages, "tool-result")[0]).toMatchObject({
          status: "ok",
          output: { people: POPULATION },
        });
        // No message anywhere in the tree is left looking like it is still
        // streaming, at either level.
        expect(state.messages.slice(1).every((message) => Boolean(message.finishReason))).toBe(
          true,
        );
        expect(sub.messages.every((message: AgentMessage) => Boolean(message.finishReason))).toBe(
          true,
        );

        // The reducer's own contract, checked against real frames rather than
        // hand-written ones: redelivery converges. A reattaching client is
        // handed frames it already has.
        expect(replay(wire, state)).toEqual(state);
        expect(replay()).toEqual(state);

        // And the other shape a real client meets: `/attach?from=0` after the
        // run has finished serializes the buffered frames as they are NOW, so
        // the tool-call part already carries the whole nested transcript and
        // every `nested-event` then arrives on top of it. Nothing may be
        // applied twice, or a late attach renders the sub-agent's answer twice.
        const settled = replay(JSON.parse(JSON.stringify(live)));
        expect(settled.messages.map((message) => message.id)).toEqual(
          state.messages.map((message) => message.id),
        );
        expect(transcriptText(settled.messages)).toBe(transcriptText(state.messages));
        const settledSub = partsOf(settled.messages, "tool-call").find(
          (part) => part.name === "delegate",
        ).nested[0];
        // Compared over the sub-run's ASSISTANT turns, because the two clients
        // legitimately see different amounts here: the recorded `NestedRun`
        // opens with the sub-agent's own user turn, and the live stream never
        // carried it (a run emits no `message-start` for the turn it was given,
        // at any depth). More, not doubled — which is what this checks.
        const assistants = (messages: AgentMessage[]) =>
          messages.filter((message) => message.role === "assistant");
        expect(assistants(settledSub.messages).map((message) => message.id)).toEqual(
          assistants(sub.messages).map((message) => message.id),
        );
        expect(transcriptText(assistants(settledSub.messages))).toBe(
          transcriptText(assistants(sub.messages)),
        );
      },
      TIMEOUT,
    );
  });
}

for (const target of TARGETS) battery(target);
