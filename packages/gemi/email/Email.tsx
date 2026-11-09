import type { ComponentType } from "react";
import { render } from "jsx-email";
import open from "open";
import { app } from "../foundation/app";
import { MailManager } from "../services/email/MailManager";
import { deliverThrough } from "../services/email/deliver";
import type {
  EmailSendResult,
  SendEmailParams,
} from "../services/email/drivers/types";
import { Translator } from "../i18n/Translator";
import { writeDebugEmail } from "./debugEmail";

interface SendEmailArgs<T> extends Partial<Omit<SendEmailParams, "html">> {
  data: Omit<T, "locale">;
  locale?: string;
  /** A driver registered under `drivers` in the mail config, for this send. */
  driver?: string;
}

function namedDriver(mail: MailManager, name: string) {
  // A manager replaced by the app may predate named drivers.
  if (typeof mail.driverFor !== "function") {
    throw new Error(
      `Can't send through mail driver "${name}": the bound MailManager has no \`driverFor\`.`,
    );
  }
  return mail.driverFor(name);
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
  replyTo?: string[];
  /**
   * A driver registered under `drivers` in the mail config. Unset, the class
   * sends through the default `driver`.
   */
  driver?: string;

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
      replyTo = instance.replyTo,
      data,
      headers = {},
    } = args;

    // Resolved before anything else so an unknown name fails in debug and
    // tests too, not only in production.
    const driverName = args.driver ?? instance.driver;
    const driver =
      driverName === undefined ? undefined : namedDriver(mail, driverName);

    const _headers = {
      ...(mail.headers ?? {}),
      ...(instance.headers ?? {}),
      ...(headers ?? {}),
    };

    const debug = process.env.EMAIL_DEBUG === "true";
    const provider = debug
      ? "debug"
      : ((driver ?? mail.driver)?.provider ?? "custom");

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
      ...(replyTo?.length ? { replyTo } : {}),
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
        { locale: args.locale, driver: driverName },
      );
      // `EMAIL_DEBUG_OPEN=false` keeps the file without opening it, without
      // the rest of what `CI=true` changes (#1190).
      if (process.env.CI !== "true" && process.env.EMAIL_DEBUG_OPEN !== "false") {
        await open(fileName);
      }
      return { id: `debug_${crypto.randomUUID()}`, provider, status: "debug" };
    }

    // A manager replaced by the app (see "Replacing the manager entirely")
    // that predates `deliver`, or only overrides `send`, is called through
    // `send`.
    // A named driver is called directly; the default goes through the manager.
    const result = await deliverThrough(driver ?? mail, params);

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
