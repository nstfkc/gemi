export type EmailAttachment = {
  filename: string;
  content: Buffer;
};

export interface SendEmailParams {
  from: string;
  to: string[];
  subject: string;
  cc: string[];
  bcc: string[];
  attachments: EmailAttachment[];
  html: string;
  text?: string;
  headers?: Record<string, string>;
  scheduledAt?: string;
  /**
   * A key that makes retries of the same send safe: the provider delivers the
   * first request with a given key and answers repeats without sending again.
   * Forwarded by drivers that support it (Resend: the `Idempotency-Key`
   * header, honoured for 24 hours); ignored by those that don't.
   */
  idempotencyKey?: string;
}

/**
 * What a driver reports about one delivery attempt. `id` is the provider's
 * message id when it returns one, so an app can store it for delivery
 * tracking (webhooks, support lookups).
 */
export interface EmailDeliveryResult {
  ok: boolean;
  id: string | null;
  error?: unknown;
}

/**
 * What `Email.send` resolves to.
 *
 * - `sent`: the driver accepted the message; `id` is its message id (or `null`
 *   for a driver that doesn't return one).
 * - `failed`: the driver rejected it; `error` is what it reported.
 * - `skipped`: `filterRecipients` left nobody to send to.
 * - `debug`: `EMAIL_DEBUG=true` wrote the mail to disk; `id` is a fake id.
 */
export interface EmailSendResult {
  id: string | null;
  provider: string;
  status: "sent" | "failed" | "skipped" | "debug";
  error?: unknown;
}
