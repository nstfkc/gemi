import { mailConfigDefaults, type MailConfig } from "./config";
import type { EmailDriver } from "./drivers/EmailDriver";
import type { EmailDeliveryResult, SendEmailParams } from "./drivers/types";

export class MailManager {
  static token = "mail";

  readonly driver: EmailDriver;
  readonly headers: Record<string, string>;

  private readonly recipientFilter: NonNullable<MailConfig["filterRecipients"]>;

  constructor(config: MailConfig = {}) {
    const defaults = mailConfigDefaults();

    this.driver = config.driver ?? defaults.driver;
    this.headers = config.headers ?? defaults.headers;
    this.recipientFilter = config.filterRecipients ?? defaults.filterRecipients;
  }

  filterRecipients(emails: string[]): Promise<Array<string>> | Array<string> {
    return this.recipientFilter(emails);
  }

  send(params: SendEmailParams) {
    return this.driver.send(params);
  }

  /** Like `send`, but reports the outcome and the provider's message id. */
  async deliver(params: SendEmailParams): Promise<EmailDeliveryResult> {
    // A driver object that doesn't extend `EmailDriver` may only have `send`.
    if (typeof this.driver.deliver === "function") {
      return this.driver.deliver(params);
    }
    return { ok: Boolean(await this.driver.send(params)), id: null };
  }
}
