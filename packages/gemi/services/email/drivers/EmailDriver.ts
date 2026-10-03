import type { EmailDeliveryResult, SendEmailParams } from "./types";

export abstract class EmailDriver {
  /**
   * The provider's name, reported as `provider` in what `Email.send` returns.
   * Override it in a custom driver.
   */
  readonly provider: string = "custom";

  /**
   * Whether the driver forwards `params.idempotencyKey` to its provider. A
   * driver that doesn't ignores the key.
   */
  readonly supportsIdempotencyKey: boolean = false;

  abstract send(params: SendEmailParams): Promise<boolean> | boolean;

  /**
   * Sends and reports the outcome with the provider's message id. `Email.send`
   * calls this. The default wraps `send`, so a driver that only implements
   * `send` keeps working and reports `id: null`; override it to return the id.
   */
  async deliver(params: SendEmailParams): Promise<EmailDeliveryResult> {
    const ok = await this.send(params);
    return { ok: Boolean(ok), id: null };
  }
}
