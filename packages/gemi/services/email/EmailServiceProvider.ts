import { ServiceProvider } from "../ServiceProvider";
import type { EmailDriver } from "./drivers/EmailDriver";
import { ResendDriver } from "./drivers/ResendDriver";

export class EmailServiceProvider extends ServiceProvider {
  driver: EmailDriver = new ResendDriver();

  boot() {}

  filterRecipients(emails: string[]): Promise<Array<string>> | Array<string> {
    return emails;
  }
}
