import type { EmailDriver } from "./drivers/EmailDriver";
import { ResendDriver } from "./drivers/ResendDriver";

// Config key: `mail`. Derived from `EmailServiceProvider`.
export interface MailConfig {
  driver?: EmailDriver;
  headers?: Record<string, string>;

  // Last chance to drop or rewrite recipients before a send leaves the app.
  filterRecipients?: (
    emails: string[],
  ) => Promise<Array<string>> | Array<string>;
}

export function defineMailConfig(config: MailConfig): MailConfig {
  return config;
}

export function mailConfigDefaults(): Required<MailConfig> {
  return {
    driver: new ResendDriver(),
    headers: {},
    filterRecipients: (emails) => emails,
  };
}
