import { ComponentType } from "react";
import { render } from "jsx-email";
import { EmailServiceContainer } from "../services/email/EmailServiceContainer";
import { SendEmailParams } from "../services/email/drivers/types";

interface SendEmailArgs<T> extends Partial<Omit<SendEmailParams, "html">> {
  data: T;
}

export class Email {
  from = "";
  to = [];
  subject = "No Subject";
  cc = [];
  bcc = [];
  attachments = [];
  template: ComponentType<any>;

  static async send<T extends Email>(
    this: new () => T,
    args: SendEmailArgs<
      T["template"] extends (p: infer P) => JSX.Element ? P : never
    >,
  ) {
    const instance = new this();

    const {
      to = instance.to,
      from = instance.from,
      subject = instance.subject,
      cc = instance.cc,
      bcc = instance.bcc,
      attachments = instance.attachments,
      data,
    } = args;

    const html = await instance.render(data);

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
