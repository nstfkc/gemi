import { Kernel } from "../kernel";
import { EmailTemplate, ExtractRenderPropsType } from "./EmailTemplate";
import { SendEmailParams } from "./types";
import { renderToStaticMarkup } from "react-dom/server";

export const render = (component: React.ReactElement) => {
  const doctype =
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';
  const markup = renderToStaticMarkup(component);
  const document = `${doctype}${markup}`;

  return document;
};

interface EmailTemplateParams<T>
  extends Partial<Omit<SendEmailParams, "html">> {
  data: T;
}

export class Email {
  static async send<T extends new () => EmailTemplate>(
    Template: T,
    params: EmailTemplateParams<ExtractRenderPropsType<T>>,
  ) {
    const template = new Template();

    const {
      to = template.to,
      from = template.from,
      subject = template.subject,
      cc = template.cc,
      bcc = template.bcc,
      attachments = template.attachments,
      data,
    } = params;

    const html = render(template.render(data));

    if (process.env.EMAIL_DEBUG) {
      const fileName = `${process.env.ROOT_DIR}/.debug/emails/${new Date().toISOString()}${subject}.html`;
      await Bun.write(fileName, html);
      Bun.spawnSync(["open", fileName]);
      return;
    }

    await Kernel.getContext().emailServiceProvider.send({
      bcc,
      cc,
      from,
      subject,
      to,
      attachments,
      html,
    });
  }
}
