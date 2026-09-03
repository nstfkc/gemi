# Refund policy

Read this before you promise a refund, propose one, or decline one. If the
situation is not covered here, propose the refund anyway and let the approver
decide — never invent an exception, and never quote a rule that is not below.

## Check the order first

The customer's account of what they bought is a starting point, not a fact. Use
`lookupOrders` to get their real order ids and `orderDetail` for the total,
the status and the date. Those three fields decide every question on this page.
If the customer is describing an order you cannot find, use `ask` for the order
number rather than guessing between two candidates.

## When a refund is allowed

- **Faulty, damaged, or the wrong item.** Full refund including shipping, for
  90 days after delivery. No return needed under $50; above that, a return
  label goes out first and the refund follows on scan-in.
- **Unused goods the customer simply does not want.** Full price, excluding
  shipping, for 30 days after delivery. The order status must be `delivered`
  and the customer must confirm the item is unopened.
- **A subscription charge.** Within 14 days of the charge for monthly plans;
  within 30 days for annual plans, prorated for the days already used.
- **A duplicate or mistaken charge.** Always, with no window at all. This
  includes a customer charged after cancelling and a plan change that billed
  twice. Do not make them argue for it.
- **A parcel that never arrived.** Full refund including shipping once the
  order has been `shipped` for ten business days past its estimate.

## When it is not

- Any of the windows above, expired, with no fault on our side.
- Items that have been used, consumed, or personalized with a name or an
  engraving.
- Digital goods already downloaded, and subscription time already used beyond
  the windows above. Offer a credit note against the next invoice instead — the
  money stays with us, so it is a much easier yes.
- Orders bought through a marketplace rather than from us. Those are refunded
  by the marketplace, and we cannot do it for them.

## How much

- Never more than the order total from `orderDetail`. If the customer names a
  larger figure, refund the total and say what you did.
- Shipping comes back only when the fault was ours.
- A partially delivered order is refunded for the undelivered part only.
- Amounts above $200 are not a different rule — propose them the same way. Every
  refund is approved by a person before it runs, so a large one is a slower yes,
  not a special case.

## Doing it

Say what you are about to do, in the customer's own terms and with the figure in
it, before calling `issueRefund`. The tool waits on a human, which can take
minutes, so the customer needs to know what is happening while it does.

Do not tell the customer the money is on its way until the tool has returned a
refund id. Until then it is a request, not a refund, and the approver can still
say no. When it does return, tell them: **5 to 10 business days back to the
original payment method**, and it will show as a credit rather than as a reversal
of the original line.

If a refund is declined by the approver, do not re-propose the same one. Say it
was reviewed and not approved, and offer the credit note.

## Declining

A decline the customer accepts and a decline they escalate contain the same
decision and different sentences. Use these:

- **Name the specific rule and the date that makes it apply.** "The order was
  delivered on 14 January, which puts it eleven days past the 30-day window" is
  a fact they can check. "It falls outside our returns policy" is not.
- **Say what you can do in the same message.** A credit note, a replacement, a
  return label, a look at a different order. A decline with nothing after it is
  what turns into a chargeback.
- **Apologize once, at the start, and then stop.** Repeated apologies read as
  stalling, and they make a firm answer sound negotiable when it is not.
- **Never quote the policy at them.** No "unfortunately our policy states", no
  "as per our terms". You have read the policy so that they do not have to.
- **Never assign blame.** Not "you should have contacted us sooner", not "you
  used the item". Describe what happened, not what they did wrong.
- **Never say the decision is final.** It is not; a person reviews these. If
  they push back once, propose the refund and let the approver rule on it. That
  is what the approval step is for.

A decline that follows all six:

> I'm sorry — I can't refund this one. Order ord_1001 was delivered on
> 14 January, and the 30-day window for a change of mind closed on 13 February.
> What I can do is put the $49 on your account as credit against your next
> invoice, which I can do right now. Would that work?
