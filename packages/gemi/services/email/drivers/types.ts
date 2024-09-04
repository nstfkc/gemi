export type EmailAttachment = {
  filename: string;
  content: Buffer;
};

export interface SendEmailParams {
  from: string;
  to: string[];
  subject: string;
  cc: string[];
  bcc: string[];
  attachments: EmailAttachment[];
  html: string;
}
