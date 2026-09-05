import { AgentTool, s } from "gemi/ai";

/**
 * Every body in this file is a deterministic fake over the table below: no
 * database, no network, no clock. The template is teaching the agent API, and a
 * tool that can fail for a reason unrelated to it — an unseeded database, a
 * rate-limited vendor, today's date — teaches the wrong lesson the first time
 * it does. Swap the bodies for real work and nothing above them changes.
 */
const ORDERS: Record<
  string,
  { customer: string; totalCents: number; status: string; placedAt: string }
> = {
  ord_1001: { customer: "cus_ada", totalCents: 4900, status: "delivered", placedAt: "2025-01-14" },
  ord_1002: { customer: "cus_ada", totalCents: 12900, status: "shipped", placedAt: "2025-02-02" },
  ord_1003: { customer: "cus_ada", totalCents: 2400, status: "refunded", placedAt: "2024-11-30" },
  ord_2001: { customer: "cus_gus", totalCents: 8900, status: "delivered", placedAt: "2025-01-28" },
};

export const lookupOrdersTool = AgentTool.create({
  name: "lookupOrders",
  description:
    "List the order ids belonging to a customer. Start here when you only have a customer.",
  inputSchema: s.object({
    // The only prose the model gets about this field, so it says what an id
    // looks like rather than restating the field name.
    customerId: s.string().describe("The customer's id, e.g. cus_ada"),
  }),
  outputSchema: s.object({ orderIds: s.array(s.string()) }),
  // An unknown customer comes back empty instead of throwing. An empty list is
  // something the model can act on — ask for a different id, or tell the person
  // there is nothing on file — whereas a failure only tells it the tool broke,
  // and its next move is usually to call the same tool again.
  execute: async (input) => ({
    orderIds: Object.entries(ORDERS)
      .filter(([, order]) => order.customer === input.customerId)
      .map(([orderId]) => orderId),
  }),
});

export const orderDetailTool = AgentTool.create({
  name: "orderDetail",
  description: "Read one order in full: what it cost, where it is, and when it was placed",
  inputSchema: s.object({ orderId: s.string().describe("An order id, e.g. ord_1001") }),
  outputSchema: s.object({
    totalCents: s.number(),
    status: s.string(),
    placedAt: s.string().describe("The date the order was placed, as YYYY-MM-DD"),
  }),
  // The throw is not an exception out of the run: gemi records it as a failed
  // tool result the model reads and recovers from. So the sentence is written
  // for the model — it names the tool that produces real ids — rather than for
  // a log, which is where an id-not-found message usually ends up being aimed.
  execute: async (input) => {
    const order = ORDERS[input.orderId];
    if (!order) {
      throw new Error(
        `There is no order ${input.orderId}. Call lookupOrders for this customer's real ids.`,
      );
    }
    return { totalCents: order.totalCents, status: order.status, placedAt: order.placedAt };
  },
});

export const issueRefundTool = AgentTool.create({
  name: "issueRefund",
  description:
    "Refund part or all of an order. A human approves every call before it runs, so propose one " +
    "when the policy allows it rather than asking the customer to wait for a colleague.",
  inputSchema: s.object({
    orderId: s.string(),
    amountCents: s
      .number()
      .describe("How much to refund, in cents. Never more than the order total."),
    reason: s
      .string()
      .describe("One sentence in the customer's own terms, kept for the audit trail"),
  }),
  outputSchema: s.object({ refundId: s.string() }),
  // The only tool here that moves money, so the server will not run it until a
  // person says yes: `requiresApproval` ends the stream `awaiting-input` and
  // hands the client a pending call whose token is signed with `SECRET` over the
  // run id, the tool name and the exact input the server saw. The client can
  // refuse — that is the point of asking — but it cannot raise `amountCents` on
  // the way back and still produce a signature that verifies.
  //
  // The token also carries a nonce that is spent when the answer is consumed,
  // so a replayed approval is refused instead of paying the refund twice. That
  // guarantee lives in the framework, not in this body, which is why the body
  // is allowed to be a plain non-idempotent write.
  requiresApproval: true,
  execute: async (input) => ({
    refundId: `rf_${input.orderId.slice(4)}_${input.amountCents}`,
  }),
});

export const runDiagnosticsTool = AgentTool.create({
  name: "runDiagnostics",
  description: "Run the payment and fulfilment checks for an order and summarize what they found",
  inputSchema: s.object({ orderId: s.string() }),
  outputSchema: s.object({ summary: s.string(), checks: s.number() }),
  // An async generator rather than an async function, and the difference is
  // visible in the browser: each `yield` is emitted as a `tool-progress` event
  // and lands on the call part's `progress`, typed by what this body actually
  // yields — `{ line: string }` — instead of as `unknown`. A twenty-second tool
  // is the normal case, and a chat that shows nothing for twenty seconds looks
  // broken.
  //
  // The inverse is the half worth knowing before designing the UI. A tool whose
  // `execute` returns a promise cannot yield, so its progress type is `never`
  // and `part.progress` for it is `never[]`: a component that tries to render
  // progress for `orderDetail` does not compile. That is what stops a client
  // shipping a progress renderer for a tool that can never produce a frame to
  // put in it.
  execute: async function* (input) {
    yield { line: `Reading ${input.orderId}` };
    const order = ORDERS[input.orderId];
    if (!order) {
      return { summary: `There is no order ${input.orderId}, so nothing was checked.`, checks: 0 };
    }
    yield { line: `Payment: ${order.totalCents} cents captured in full` };
    yield { line: `Fulfilment: ${order.status}` };
    yield { line: "Address: validated, no delivery exceptions" };
    return {
      summary: `${input.orderId} is ${order.status}, paid in full, with no address problems.`,
      checks: 3,
    };
  },
});

// Answered by the person, not the server: gemi ends the stream `awaiting-input`
// and the browser supplies the result, which arrives back as an ordinary turn.
// It is the same mechanism an approval uses — an approval is just a question
// whose answer is a boolean — which is why there is no second endpoint for
// either of them and why `useChat` exposes both through one `pending` list.
//
// Use it for what cannot be looked up. Anything that *can* be looked up should
// be a tool with an `execute`, because a question costs a round trip through a
// human who is already waiting.
export const askTool = AgentTool.ask({
  name: "ask",
  description:
    "Ask the customer for something you cannot look up: which order they mean, whether to " +
    "proceed, where to send a replacement",
  outputSchema: s.object({ answer: s.string() }),
});
