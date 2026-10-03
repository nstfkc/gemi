import type { ComponentType } from "react";
import { render } from "jsx-email";
import open from "open";
import { app } from "../foundation/app";
import { MailManager } from "../services/email/MailManager";
import type {
  EmailDeliveryResult,
  EmailSendResult,
  SendEmailParams,
} from "../services/email/drivers/types";
import { Translator } from "../i18n/Translator";
import { writeDebugEmail } from "./debugEmail";

interface SendEmailArgs<T> extends Partial<Omit<SendEmailParams, "html">> {
  data: Omit<T, "locale">;
  locale?: string;
}

/**
 * A `MailManager` swapped in by an app (see "Replacing the manager entirely"
 * in the email docs) may predate `deliver`; fall back to its `send`.
 */
async function deliver(
  mail: MailManager,
  params: SendEmailParams,
): Promise<EmailDeliveryResult> {
  if (typeof mail.deliver === "function") {
    return mail.deliver(params);
  }
  const ok = await (mail as Pick<MailManager, "send">).send(params);
  return { ok: Boolean(ok), id: null };
}

export class Email {
  from = "";
  to = [];
  subject: string | Record<string, string> = "No Subject";
  cc = [];
  bcc = [];
  attachments = [];
  template: ComponentType<any>;
  headers: Record<string, string> = {};

  static async send<T extends Email>(
    this: new () => T,
    args: SendEmailArgs<T["template"] extends (p: infer P) => any ? P : never>,
  ): Promise<EmailSendResult> {
    const instance = new this();

    const defaultLocale = app(Translator).defaultLocale;
    const mail = app(MailManager);

    const {
      to = instance.to,
      from = instance.from,
      subject = typeof instance.subject === "string"
        ? instance.subject
        : instance.subject[args.locale || defaultLocale],
      cc = instance.cc,
      bcc = instance.bcc,
      attachments = instance.attachments,
      data,
      headers = {},
    } = args;

    const _headers = {
      ...(mail.headers ?? {}),
      ...(instance.headers ?? {}),
      ...(headers ?? {}),
    };

    const debug = process.env.EMAIL_DEBUG === "true";
    const provider = debug ? "debug" : (mail.driver?.provider ?? "custom");

    const recipients = await mail.filterRecipients(to);

    if (!recipients.length) {
      return { id: null, provider, status: "skipped" };
    }

    const [html, text] = await Promise.all([
      instance.render({
        ...(data as any),
        locale: args.locale,
      }),
      instance.renderText({
        ...(data as any),
        locale: args.locale,
      }),
    ]);

    const params: SendEmailParams = {
      bcc,
      cc,
      from,
      subject,
      // What `filterRecipients` kept, not what was asked for.
      to: recipients,
      attachments,
      html,
      headers: _headers,
      text,
      scheduledAt: args.scheduledAt,
      idempotencyKey: args.idempotencyKey,
    };

    if (debug) {
      const fileName = await writeDebugEmail(
        `${process.env.ROOT_DIR}/.debug/emails`,
        params,
        { locale: args.locale },
      );
      if (process.env.CI !== "true") {
        await open(fileName);
      }
      return { id: `debug_${crypto.randomUUID()}`, provider, status: "debug" };
    }

    const result = await deliver(mail, params);

    return result.ok
      ? { id: result.id, provider, status: "sent" }
      : { id: result.id, provider, status: "failed", error: result.error };
  }

  static async preview<T extends Email>(
    this: new () => T,
    args: Pick<SendEmailArgs<T["template"] extends (p: infer P) => any ? P : never>, "data" | "locale">,
  ) {

    const instance = new this();

    return await instance.render({
      ...args.data,
      locale: args.locale,
    })
  }

  protected async render<T extends Record<string, any>>(props: T) {
    const Template = this.template;
    return await render(<Template {...props} />);
  }

  protected async renderText<T extends Record<string, any>>(props: T) {
    const Template = this.template;
    return await render(<Template {...props} />, { plainText: true });
  }
}
