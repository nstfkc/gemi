type Attachment = {
  filename: string;
  content: Buffer;
};

export interface SendEmailParams {
  from: string;
  to: string[];
  subject: string;
  cc: string[];
  bcc: string[];
  attachments: Attachment[];
  html: string;
}
