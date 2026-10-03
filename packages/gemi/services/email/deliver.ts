import type { EmailDeliveryResult, SendEmailParams } from "./drivers/types";

interface Sender {
  send(params: SendEmailParams): unknown;
  deliver?(params: SendEmailParams): Promise<EmailDeliveryResult>;
}

/**
 * Whether `send` is overridden below the class that defines `deliver` (or
 * there is no `deliver`). A manager or driver subclassed before `deliver`
 * existed, wrapping `send` to audit or rewrite a message, must keep being
 * called through `send`.
 */
function sendIsOverridden(target: Sender) {
  for (let proto = target; proto; proto = Object.getPrototypeOf(proto)) {
    const ownDeliver = Object.prototype.hasOwnProperty.call(proto, "deliver");
    const ownSend = Object.prototype.hasOwnProperty.call(proto, "send");
    if (ownDeliver) return false;
    if (ownSend) return true;
  }
  return true;
}

/**
 * Delivers through `deliver` when the target has one that `send` doesn't
 * shadow, and otherwise through `send`, reporting no message id.
 */
export async function deliverThrough(
  target: Sender,
  params: SendEmailParams,
): Promise<EmailDeliveryResult> {
  if (typeof target.deliver === "function" && !sendIsOverridden(target)) {
    return target.deliver(params);
  }
  return { ok: Boolean(await target.send(params)), id: null };
}
