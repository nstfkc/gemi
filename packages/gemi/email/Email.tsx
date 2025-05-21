import type { ComponentType } from "react";
import { render } from "jsx-email";
import { EmailServiceContainer } from "../services/email/EmailServiceContainer";
import type { SendEmailParams } from "../services/email/drivers/types";
import { I18nServiceContainer } from "../i18n/I18nServiceContainer";

interface SendEmailArgs<T> extends Partial<Omit<SendEmailParams, "html">> {
  data: Omit<T, "locale">;
  locale?: string;
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
  ) {
    const instance = new this();

    const defaultLocale = I18nServiceContainer.use().service.defaultLocale;
    const emailService = EmailServiceContainer.use().service;

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
      ...(emailService.headers ?? {}),
      ...(instance.headers ?? {}),
      ...(headers ?? {}),
    };

    const recipients = await emailService.filterRecipients(to);

    if (!recipients.length) {
      return;
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

    if (process.env.EMAIL_DEBUG === "true") {
      const fileName = `${process.env.ROOT_DIR}/.debug/emails/${new Date().toISOString()}${subject}.html`;
      await Bun.write(fileName, html);
      Bun.spawnSync(["open", fileName]);
      return;
    }

    await EmailServiceContainer.use().service.driver.send({
      bcc,
      cc,
      from,
      subject,
      to,
      attachments,
      html,
      headers: _headers,
      text,
    });
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
