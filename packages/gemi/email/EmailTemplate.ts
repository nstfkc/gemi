import { createElement, Fragment } from "react";

export interface IEmailTemplate {
  from: string;
  to: string[];
  subject: string;
  cc: string[];
  bcc: string[];
  // TODO: implement attachments
  attachments: any[];

  render: (props: unknown) => JSX.Element;
}

export type ExtractRenderPropsType<T> = T extends new () => EmailTemplate
  ? Parameters<InstanceType<T>["render"]>[0]
  : never;

export class EmailTemplate implements IEmailTemplate {
  from = "doe@gemijs.dev";
  to = ["hi@gemijs.dev"];
  subject = "Welcome";
  cc = [];
  bcc = [];
  attachments = [];

  render(_props: never) {
    console.log("EmailTemplate");
    return createElement(Fragment, null, "EmailTemplate");
  }
}
