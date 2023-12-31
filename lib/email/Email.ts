import { EmailOptions, JSONLike } from "../types/global";
import { renderEmail } from "./renderEmail";

// @app import
import { EmailServiceProvider } from "@/app/providers/EmailServiceProvider";

export class Email {
  constructor(
    private templatePath: string,
    private data: JSONLike,
  ) {}

  async send(options: EmailOptions) {
    const provider = new EmailServiceProvider();
    const html = await renderEmail(this.templatePath, this.data);
    if (options.debug === true || process.env.EMAIL_PROVIDER === "debug") {
      await this.debug(this.templatePath, html);
    } else {
      return await provider.sendEmail(html, options);
    }
  }

  async debug(templatePath: string, html: string) {
    const fileName = `${process.env.DEBUG_DIR}/${templatePath
      .split("/")
      .join("-")}.html`;

    await Bun.write(fileName, html);

    Bun.spawnSync(["open", fileName]);
  }
}
