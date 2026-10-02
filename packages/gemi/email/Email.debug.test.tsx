import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Translator } from "../i18n/Translator";
import { debugEmailFileSubject } from "./debugEmail";

/**
 * `EMAIL_DEBUG=true` used to write the rendered HTML and nothing else, so a
 * test could not tell who a mail went to (gemi#672). It now writes a JSON
 * sidecar with the envelope next to the HTML, recording `to` after
 * `filterRecipients` — which is also what a real send now hands the driver.
 */

const driverSend = vi.fn(async (_params: unknown) => {});
let recipientFilter = (emails: string[]) => emails;

const mail = {
  headers: { "X-App": "gemi" },
  filterRecipients: (emails: string[]) => recipientFilter(emails),
  send: (params: unknown) => driverSend(params),
};

vi.mock("../foundation/app", () => ({
  app: (token: unknown) => (token === Translator ? { defaultLocale: "en-US" } : mail),
}));
vi.mock("open", () => ({ default: vi.fn() }));

const { Email } = await import("./Email");

function Template({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

class WelcomeEmail extends Email {
  from = "hello@example.com";
  subject = "Welcome to Example";
  template = Template;
  headers = { "X-Template": "welcome" };
}

let root: string;
const env = { ...process.env };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gemi-email-debug-"));
  process.env.ROOT_DIR = root;
  process.env.EMAIL_DEBUG = "true";
  process.env.CI = "true";
  recipientFilter = (emails) => emails;
  driverSend.mockClear();
});

afterEach(async () => {
  process.env = { ...env };
  await rm(root, { recursive: true, force: true });
});

async function written() {
  const dir = join(root, ".debug/emails");
  const files = (await readdir(dir)).sort();
  const json = files.filter((f) => f.endsWith(".json"));
  return {
    files,
    records: await Promise.all(
      json.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8"))),
    ),
    html: await Promise.all(
      files.filter((f) => f.endsWith(".html")).map((f) => readFile(join(dir, f), "utf8")),
    ),
  };
}

describe("Email.send with EMAIL_DEBUG", () => {
  test("writes the HTML and a sidecar with the envelope, under the same name", async () => {
    await WelcomeEmail.send({
      to: ["ada@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      headers: { "Reply-To": "support@example.com" },
      attachments: [{ filename: "invoice.pdf", content: Buffer.from("12345") }],
      scheduledAt: "2026-10-02T10:00:00.000Z",
      locale: "tr-TR",
      data: { name: "Ada" },
    });

    const { files, records, html } = await written();
    expect(files).toHaveLength(2);
    const [htmlFile, jsonFile] = files; // sorted: .html before .json
    expect(jsonFile.replace(/\.json$/, "")).toBe(htmlFile.replace(/\.html$/, ""));
    expect(htmlFile).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+ZWelcome to Example\.html$/);

    expect(html[0]).toContain("Hello");
    expect(html[0]).toContain("Ada");
    expect(records[0]).toEqual({
      to: ["ada@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      from: "hello@example.com",
      subject: "Welcome to Example",
      headers: {
        "X-App": "gemi",
        "X-Template": "welcome",
        "Reply-To": "support@example.com",
      },
      attachments: [{ filename: "invoice.pdf", bytes: 5 }],
      scheduledAt: "2026-10-02T10:00:00.000Z",
      locale: "tr-TR",
      text: expect.stringContaining("Ada"),
    });
    expect(driverSend).not.toHaveBeenCalled();
  });

  test("records the recipients filterRecipients kept", async () => {
    recipientFilter = (emails) => emails.filter((e) => !e.startsWith("unsub"));

    await WelcomeEmail.send({
      to: ["ada@example.com", "unsub@example.com"],
      data: { name: "Ada" },
    });

    const { records } = await written();
    expect(records[0].to).toEqual(["ada@example.com"]);
    expect(records[0]).toMatchObject({
      cc: [],
      bcc: [],
      attachments: [],
      scheduledAt: null,
      locale: null,
    });
  });

  test("writes nothing when every recipient is filtered out", async () => {
    recipientFilter = () => [];

    await WelcomeEmail.send({ to: ["ada@example.com"], data: { name: "Ada" } });

    await expect(readdir(join(root, ".debug/emails"))).rejects.toThrow();
  });

  test("a subject with a path separator stays in the emails directory", async () => {
    await WelcomeEmail.send({
      to: ["ada@example.com"],
      subject: "Invoice 2026/10 \\ paid",
      data: { name: "Ada" },
    });

    const { files, records } = await written();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/Invoice 2026_10 _ paid\.html$/);
    // The record keeps the real subject.
    expect(records[0].subject).toBe("Invoice 2026/10 \\ paid");
  });
});

describe("Email.send without EMAIL_DEBUG", () => {
  test("hands the driver the filtered recipients", async () => {
    delete process.env.EMAIL_DEBUG;
    recipientFilter = (emails) => emails.filter((e) => !e.startsWith("unsub"));

    await WelcomeEmail.send({
      to: ["ada@example.com", "unsub@example.com"],
      data: { name: "Ada" },
    });

    expect(driverSend).toHaveBeenCalledOnce();
    expect(driverSend.mock.calls[0][0]).toMatchObject({
      to: ["ada@example.com"],
      from: "hello@example.com",
      subject: "Welcome to Example",
    });
  });
});

test("debugEmailFileSubject replaces separators and control characters only", () => {
  expect(debugEmailFileSubject("a/b\\c\nd: e?")).toBe("a_b_c_d: e?");
});
