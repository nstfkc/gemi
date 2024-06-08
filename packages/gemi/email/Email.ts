import { render } from "@react-email/render";
import { Fragment, createElement } from "react";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

interface SendEmailParams {
  to: string;
  from?: string;
  subject: string;
  props: any;
}

export class Email {
  params: SendEmailParams;

  constructor(params: SendEmailParams) {
    this.params = params;
  }

  async send() {
    const { props, subject, to } = this.params;
    const html = render(this.render(props));

    if (process.env.EMAIL_DEBUG) {
      const fileName = `${process.env.ROOT_DIR}/.debug/emails/${new Date().toISOString()}${subject}.html`;
      Bun.write(fileName, html);
      Bun.spawnSync(["open", fileName]);
      return;
    }

    try {
      await resend.emails.send({
        from: "enes@key5studio.com",
        to,
        html,
        subject,
      });
    } catch (err) {
      console.log(err);
    }
  }

  render(props: any): JSX.Element {
    return createElement(Fragment);
  }
}
