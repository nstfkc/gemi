import type { EmailDeliveryResult, SendEmailParams } from "./types";
import { EmailDriver } from "./EmailDriver";

export class ResendDriver extends EmailDriver {
  override readonly provider = "resend";
  override readonly supportsIdempotencyKey = true;

  constructor(private apiKey = process.env.RESEND_API_KEY) {
    super();
  }

  async send(params: SendEmailParams) {
    return (await this.deliver(params)).ok;
  }

  override async deliver(params: SendEmailParams): Promise<EmailDeliveryResult> {
    // `resend` is imported on the first send rather than at module scope,
    // because this driver is re-exported from the `gemi/services` barrel — the
    // only door an application has to `CronJob`, `Job` or `Command`. A static
    // import put the whole SDK in the module graph of every app and test that
    // touched any of them (#403). The module registry caches it, so later sends
    // pay nothing.
    const { Resend } = await import("resend");
    const resend = new Resend(this.apiKey);
    // The key is a request option (the `Idempotency-Key` header), not part of
    // the message body.
    const { idempotencyKey, ...message } = params;
    const { data, error } = await resend.emails.send(
      message,
      idempotencyKey ? { idempotencyKey } : undefined,
    );

    if (error) {
      console.error(error);
      return { ok: false, id: null, error };
    }

    if (data) {
      return { ok: true, id: data.id ?? null };
    }

    return { ok: false, id: null };
  }
}
