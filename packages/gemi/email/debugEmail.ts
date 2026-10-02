import type { SendEmailParams } from "../services/email/drivers/types";

/**
 * What `EMAIL_DEBUG=true` records about a send, next to the rendered HTML.
 *
 * The HTML alone can't say who a mail went to: plenty of templates render
 * nothing per recipient, so a test asserting "this action mailed this user"
 * could match another send with the same subject. The sidecar holds the
 * envelope the driver would have been handed, with `to` already filtered.
 */
export interface DebugEmailRecord {
  to: string[];
  cc: string[];
  bcc: string[];
  from: string;
  subject: string;
  headers: Record<string, string>;
  // Attachment bodies are left out: name and size are enough to assert on.
  attachments: Array<{ filename: string; bytes: number }>;
  scheduledAt: string | null;
  locale: string | null;
  text: string | null;
}

/**
 * A subject as a filename fragment. Path separators would write into a
 * subdirectory (or fail), and control characters aren't valid on every
 * filesystem. Everything else is kept, so a reader matching on the subject
 * substring keeps working.
 */
export function debugEmailFileSubject(subject: string) {
  return Array.from(subject, (char) => {
    const code = char.charCodeAt(0);
    return char === "/" || char === "\\" || code < 0x20 || code === 0x7f ? "_" : char;
  }).join("");
}

/**
 * Writes `<dir>/<iso><subject>.json` and then `<dir>/<iso><subject>.html`, and
 * returns the HTML path. The sidecar goes first so a reader that sees the HTML
 * can rely on its envelope being there.
 */
export async function writeDebugEmail(
  dir: string,
  params: SendEmailParams,
  options: { locale?: string } = {},
) {
  const base = `${dir}/${new Date().toISOString()}${debugEmailFileSubject(params.subject)}`;

  const record: DebugEmailRecord = {
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    from: params.from,
    subject: params.subject,
    headers: params.headers ?? {},
    attachments: params.attachments.map((attachment) => ({
      filename: attachment.filename,
      bytes: Buffer.byteLength(attachment.content),
    })),
    scheduledAt: params.scheduledAt ?? null,
    locale: options.locale ?? null,
    text: params.text ?? null,
  };

  await Bun.write(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`);
  await Bun.write(`${base}.html`, params.html);

  return `${base}.html`;
}
