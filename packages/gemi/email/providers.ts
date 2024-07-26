import { SendEmailParams } from "./types";
import { Resend } from "resend";

export const providers = {
  resend: async (params: SendEmailParams) => {
    const resend = new Resend(process.env.RESEND_API_KEY!);
    const { data, error } = await resend.emails.send({
      ...params,
    });

    if (error) {
      throw error;
    }

    if (data) {
      return true;
    }
  },
};
