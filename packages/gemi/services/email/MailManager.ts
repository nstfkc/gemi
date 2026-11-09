import { mailConfigDefaults, type MailConfig } from "./config";
import { deliverThrough } from "./deliver";
import type { EmailDriver } from "./drivers/EmailDriver";
import type { EmailDeliveryResult, SendEmailParams } from "./drivers/types";

export class MailManager {
  static token = "mail";

  readonly driver: EmailDriver;
  readonly drivers: Record<string, EmailDriver>;
  readonly headers: Record<string, string>;

  private readonly recipientFilter: NonNullable<MailConfig["filterRecipients"]>;

  constructor(config: MailConfig = {}) {
    const defaults = mailConfigDefaults();

    this.driver = config.driver ?? defaults.driver;
    this.drivers = config.drivers ?? defaults.drivers;
    this.headers = config.headers ?? defaults.headers;
    this.recipientFilter = config.filterRecipients ?? defaults.filterRecipients;
  }

  /**
   * The driver registered as `name` in `drivers`, or the default `driver`
   * without a name. An unknown name throws rather than falling back, so a typo
   * can't send through the wrong provider.
   */
  driverFor(name?: string): EmailDriver {
    if (name === undefined) return this.driver;
    const driver = Object.hasOwn(this.drivers, name) ? this.drivers[name] : undefined;
    if (!driver) {
      const known = Object.keys(this.drivers);
      throw new Error(
        `No mail driver named "${name}". Register it under \`drivers\` in the mail config${known.length ? ` (registered: ${known.join(", ")})` : ""}.`,
      );
    }
    return driver;
  }

  filterRecipients(emails: string[]): Promise<Array<string>> | Array<string> {
    return this.recipientFilter(emails);
  }

  send(params: SendEmailParams) {
    return this.driver.send(params);
  }

  /** Like `send`, but reports the outcome and the provider's message id. */
  async deliver(params: SendEmailParams): Promise<EmailDeliveryResult> {
    // A driver that doesn't extend `EmailDriver`, or a subclass that only
    // overrides `send`, is called through `send`.
    return deliverThrough(this.driver, params);
  }
}
