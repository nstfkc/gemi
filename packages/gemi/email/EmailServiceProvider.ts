import type { SendEmailParams } from "./types";
import { providers } from "./providers";

export class EmailServiceProvider {
  provider: keyof typeof providers = "resend";
  send: (params: SendEmailParams) => Promise<boolean>;

  constructor() {
    this.send = providers[this.provider];
  }
}
