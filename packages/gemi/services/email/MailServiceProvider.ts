import { ServiceProvider } from "../../support/ServiceProvider";
import type { MailConfig } from "./config";
import { MailManager } from "./MailManager";

export class MailServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      MailManager,
      () => new MailManager(this.app.config.get<MailConfig>("mail", {})),
    );
  }
}
