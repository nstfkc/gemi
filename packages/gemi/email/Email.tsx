import { ComponentType } from "react";
import { render } from "jsx-email";
import { EmailServiceContainer } from "../services/email/EmailServiceContainer";
import { SendEmailParams } from "../services/email/drivers/types";
import { I18nServiceContainer } from "../http/I18nServiceContainer";

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

  static async send<T extends Email>(
    this: new () => T,
    args: SendEmailArgs<T["template"] extends (p: infer P) => any ? P : never>,
  ) {
    const instance = new this();

    const defaultLocale = I18nServiceContainer.use().service.defaultLocale;

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
    } = args;

    const html = await instance.render({
      ...(data as any),
      locale: args.locale,
    });

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
    });
  }

  protected async render<T extends Record<string, any>>(props: T) {
    const Template = this.template;
    return await render(<Template {...props} />);
  }
}
