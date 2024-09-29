import { Resend } from "resend";
import type { SendEmailParams } from "./types";
import { EmailDriver } from "./EmailDriver";

export class ResendDriver extends EmailDriver {
  constructor(private apiKey = process.env.RESEND_API_KEY) {
    super();
  }

  async send(params: SendEmailParams) {
    const resend = new Resend(this.apiKey);
    console.log(params);
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
  }
}
