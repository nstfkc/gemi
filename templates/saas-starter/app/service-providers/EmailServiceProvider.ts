import { EmailServiceProvider } from "gemi/email";

export default class extends EmailServiceProvider {
  send(params: SendEmailParams) {
    console.log("Sending email extended");
  }
}
