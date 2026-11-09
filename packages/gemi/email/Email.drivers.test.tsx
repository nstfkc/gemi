import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Translator } from "../i18n/Translator";
import { MailManager } from "../services/email/MailManager";
import { EmailDriver } from "../services/email/drivers/EmailDriver";
import type { SendEmailParams } from "../services/email/drivers/types";

/** Named drivers in the mail config, picked per email class or per send. */

let mail: unknown;
vi.mock("../foundation/app", () => ({
  app: (token: unknown) => (token === Translator ? { defaultLocale: "en-US" } : mail),
}));
vi.mock("open", () => ({ default: vi.fn() }));

const { Email } = await import("./Email");

class RecordingDriver extends EmailDriver {
  sent: SendEmailParams[] = [];

  constructor(override readonly provider: string) {
    super();
  }

  send() {
    return true;
  }

  override async deliver(params: SendEmailParams) {
    this.sent.push(params);
    return { ok: true, id: `${this.provider}_1` };
  }
}

class ReportEmail extends Email {
  from = "reports@example.com";
  subject = "Your report";
  template = ({ name }: { name: string }) => <p>Report for {name}</p>;
}

class AlarmEmail extends ReportEmail {
  override driver = "acs";
  override replyTo = ["ops@example.com"];
}

const env = { ...process.env };
let root: string;
let primary: RecordingDriver;
let acs: RecordingDriver;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gemi-email-drivers-"));
  process.env.ROOT_DIR = root;
  process.env.CI = "true";
  delete process.env.EMAIL_DEBUG;
  primary = new RecordingDriver("primary");
  acs = new RecordingDriver("acs");
  mail = new MailManager({ driver: primary, drivers: { acs } });
});

afterEach(async () => {
  process.env = { ...env };
  await rm(root, { recursive: true, force: true });
});

describe("named mail drivers", () => {
  test("a class without `driver` uses the default driver", async () => {
    const result = await ReportEmail.send({ to: ["ada@example.com"], data: { name: "Ada" } });

    expect(result).toEqual({ id: "primary_1", provider: "primary", status: "sent" });
    expect(acs.sent).toHaveLength(0);
  });

  test("a class with `driver` sends through that driver", async () => {
    const result = await AlarmEmail.send({ to: ["ada@example.com"], data: { name: "Ada" } });

    expect(result).toEqual({ id: "acs_1", provider: "acs", status: "sent" });
    expect(primary.sent).toHaveLength(0);
    expect(acs.sent[0].replyTo).toEqual(["ops@example.com"]);
  });

  test("a send can pick a driver, overriding the class", async () => {
    await ReportEmail.send({ to: ["ada@example.com"], data: { name: "Ada" }, driver: "acs" });
    expect(acs.sent).toHaveLength(1);

    mail = new MailManager({ driver: primary, drivers: { acs, other: primary } });
    await AlarmEmail.send({ to: ["ada@example.com"], data: { name: "Ada" }, driver: "other" });
    expect(primary.sent).toHaveLength(1);
  });

  test("an unknown name throws, even under EMAIL_DEBUG", async () => {
    await expect(
      ReportEmail.send({ to: ["ada@example.com"], data: { name: "Ada" }, driver: "acss" }),
    ).rejects.toThrow('No mail driver named "acss"');

    process.env.EMAIL_DEBUG = "true";
    await expect(
      ReportEmail.send({ to: ["ada@example.com"], data: { name: "Ada" }, driver: "toString" }),
    ).rejects.toThrow('No mail driver named "toString"');
    expect(primary.sent).toHaveLength(0);
  });

  test("EMAIL_DEBUG records the driver name and replyTo", async () => {
    process.env.EMAIL_DEBUG = "true";

    await AlarmEmail.send({ to: ["ada@example.com"], data: { name: "Ada" } });

    const dir = join(root, ".debug/emails");
    const json = (await readdir(dir)).find((f) => f.endsWith(".json"))!;
    const record = JSON.parse(await readFile(join(dir, json), "utf8"));
    expect(record).toMatchObject({ driver: "acs", replyTo: ["ops@example.com"] });
    expect(acs.sent).toHaveLength(0);
  });

  test("a replaced manager without driverFor explains a named send", async () => {
    mail = { headers: {}, filterRecipients: (e: string[]) => e, send: vi.fn() };

    await expect(
      AlarmEmail.send({ to: ["ada@example.com"], data: { name: "Ada" } }),
    ).rejects.toThrow(/no `driverFor`/);
  });
});
