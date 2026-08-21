import type { SendEmailParams } from "./types";
import { EmailDriver } from "./EmailDriver";

export class ResendDriver extends EmailDriver {
  constructor(private apiKey = process.env.RESEND_API_KEY) {
    super();
  }

  async send(params: SendEmailParams) {
    // `resend` is imported on the first send rather than at module scope,
    // because this driver is re-exported from the `gemi/services` barrel — the
    // only door an application has to `CronJob`, `Job` or `Command`. A static
    // import put the whole SDK in the module graph of every app and test that
    // touched any of them (#403). The module registry caches it, so later sends
    // pay nothing.
    const { Resend } = await import("resend");
    const resend = new Resend(this.apiKey);
    const { data, error } = await resend.emails.send({
      ...params,
    });

    if (error) {
      console.error(error);
      return false;
    }

    if (data) {
      return true;
    }

    return false;
  }
}
