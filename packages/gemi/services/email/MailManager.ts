import { mailConfigDefaults, type MailConfig } from "./config";
import type { EmailDriver } from "./drivers/EmailDriver";
import type { SendEmailParams } from "./drivers/types";

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
}
