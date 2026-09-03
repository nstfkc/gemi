import { AgentTool, ToolNamespace, s } from "gemi/ai";

/**
 * The billing corner of the desk: three tools a support conversation reaches
 * for occasionally and most turns never touch at all.
 *
 * Their bodies are deterministic fakes, like everything in `tools.ts` — the
 * point of this file is the namespace at the bottom, not the arithmetic.
 */

const INVOICES: Record<string, { customerId: string; amountCents: number; status: string }> = {
  in_9001: { customerId: "cus_ada", amountCents: 4900, status: "paid" },
  in_9002: { customerId: "cus_ada", amountCents: 12900, status: "open" },
  in_9003: { customerId: "cus_gus", amountCents: 8900, status: "past_due" },
};

const invoiceLookupTool = AgentTool.create({
  name: "invoiceLookup",
  description: "Read one invoice: what it is for, what it came to, and whether it has been paid",
  inputSchema: s.object({ invoiceId: s.string().describe("An invoice id, e.g. in_9001") }),
  outputSchema: s.object({
    amountCents: s.number(),
    status: s.string().describe("One of paid, open, past_due"),
    issuedAt: s.string().describe("The date the invoice was issued, as YYYY-MM-DD"),
  }),
  execute: async (input) => {
    const invoice = INVOICES[input.invoiceId];
    if (!invoice) {
      throw new Error(`There is no invoice ${input.invoiceId}.`);
    }
    return { amountCents: invoice.amountCents, status: invoice.status, issuedAt: "2025-02-01" };
  },
});

const planChangeTool = AgentTool.create({
  name: "planChange",
  description: "Move a customer to a different plan, either immediately or at their next renewal",
  inputSchema: s.object({
    customerId: s.string(),
    plan: s.enum(["starter", "team", "enterprise"]),
    // An enum rather than a free string: the model is shown the two legal
    // values, so "at the end of the month" is resolved into one of them at
    // argument-generation time instead of being parsed out of prose in here.
    timing: s.enum(["immediately", "next_renewal"]),
  }),
  outputSchema: s.object({ plan: s.string(), effectiveAt: s.string(), proratedCents: s.number() }),
  execute: async (input) => ({
    plan: input.plan,
    effectiveAt: input.timing === "immediately" ? "2025-02-14" : "2025-03-01",
    proratedCents: input.timing === "immediately" ? 1450 : 0,
  }),
});

const creditNoteTool = AgentTool.create({
  name: "creditNote",
  description:
    "Credit an invoice against the customer's next bill. Not a refund — the money does not " +
    "leave, so use issueRefund when the customer wants it back.",
  inputSchema: s.object({
    invoiceId: s.string(),
    amountCents: s.number(),
    reason: s.string().describe("One sentence, kept on the credit note itself"),
  }),
  outputSchema: s.object({ creditNoteId: s.string(), amountCents: s.number() }),
  execute: async (input) => ({
    creditNoteId: `cn_${input.invoiceId.slice(3)}`,
    amountCents: input.amountCents,
  }),
});

/**
 * A group the model searches rather than reads.
 *
 * `deferred: true` withholds every schema in here until the model asks for one:
 * the prompt carries the namespace's description plus a line per tool, and the
 * parameters arrive only on the turn something inside is actually wanted. That
 * is what keeps a long tail of rarely-used tools from costing anything on the
 * turns that never touch them — and most support turns are about a parcel, not
 * about proration.
 *
 * It is a statement about the prompt and nothing else. It does not change who
 * runs these tools, when they run, or what they return, and a provider without
 * tool search is simply sent the schemas inline and behaves identically. So the
 * cost of being wrong about it is one turn's tokens, not a broken agent.
 *
 * The namespace also never reaches the browser: the client discriminates a tool
 * part on `name` alone, so `part.name === "invoiceLookup"` narrows there exactly
 * as it does for a top-level tool.
 */
export const billingNamespace = ToolNamespace.create({
  name: "billing",
  // What the model reads when deciding whether to look inside, so it describes
  // the territory rather than the three functions — the tool names are listed
  // for it already.
  description: "Invoices, plan changes and credits for a customer's subscription",
  deferred: true,
  tools: [invoiceLookupTool, planChangeTool, creditNoteTool],
});
