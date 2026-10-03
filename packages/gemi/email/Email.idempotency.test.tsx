import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Translator } from "../i18n/Translator";
import { MailManager } from "../services/email/MailManager";
import { EmailDriver } from "../services/email/drivers/EmailDriver";
import type { EmailDeliveryResult, SendEmailParams } from "../services/email/drivers/types";

/**
 * `Email.send` takes an `idempotencyKey` for safe retries and resolves to the
 * provider's message id (gemi#715).
 */

const resendSend = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

let mail: unknown;
vi.mock("../foundation/app", () => ({
  app: (token: unknown) => (token === Translator ? { defaultLocale: "en-US" } : mail),
}));
vi.mock("open", () => ({ default: vi.fn() }));

const { Email } = await import("./Email");
const { ResendDriver } = await import("../services/email/drivers/ResendDriver");

class ReportEmail extends Email {
  from = "reports@example.com";
  subject = "Your report";
  template = ({ name }: { name: string }) => <p>Report for {name}</p>;
}

class RecordingDriver extends EmailDriver {
  override readonly provider = "recording";
  sent: SendEmailParams[] = [];
  result: EmailDeliveryResult = { ok: true, id: "msg_1" };

  send() {
    return true;
  }

  override async deliver(params: SendEmailParams) {
    this.sent.push(params);
    return this.result;
  }
}

/** A driver written before `deliver` existed: only `send`, returning a boolean. */
class LegacyDriver extends EmailDriver {
  calls: SendEmailParams[] = [];
  ok = true;

  send(params: SendEmailParams) {
    this.calls.push(params);
    return this.ok;
  }
}

const env = { ...process.env };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gemi-email-idem-"));
  process.env.ROOT_DIR = root;
  process.env.CI = "true";
  delete process.env.EMAIL_DEBUG;
  resendSend.mockReset();
});

afterEach(async () => {
  process.env = { ...env };
  await rm(root, { recursive: true, force: true });
});

describe("Email.send", () => {
  test("forwards the idempotency key and returns the message id", async () => {
    const driver = new RecordingDriver();
    mail = new MailManager({ driver });

    const result = await ReportEmail.send({
      to: ["ada@example.com"],
      data: { name: "Ada" },
      idempotencyKey: "report:1:ada",
    });

    expect(result).toEqual({ id: "msg_1", provider: "recording", status: "sent" });
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0].idempotencyKey).toBe("report:1:ada");
  });

  test("reports a failed send with the driver's error", async () => {
    const driver = new RecordingDriver();
    driver.result = { ok: false, id: null, error: { message: "rate limited" } };
    mail = new MailManager({ driver });

    const result = await ReportEmail.send({ to: ["ada@example.com"], data: { name: "Ada" } });

    expect(result).toEqual({
      id: null,
      provider: "recording",
      status: "failed",
      error: { message: "rate limited" },
    });
  });

  test("is skipped when filterRecipients leaves nobody", async () => {
    const driver = new RecordingDriver();
    mail = new MailManager({ driver, filterRecipients: () => [] });

    const result = await ReportEmail.send({ to: ["ada@example.com"], data: { name: "Ada" } });

    expect(result).toEqual({ id: null, provider: "recording", status: "skipped" });
    expect(driver.sent).toHaveLength(0);
  });

  test("a driver with only `send` still works and reports no id", async () => {
    const driver = new LegacyDriver();
    mail = new MailManager({ driver });

    const result = await ReportEmail.send({
      to: ["ada@example.com"],
      data: { name: "Ada" },
      idempotencyKey: "k",
    });

    expect(result).toEqual({ id: null, provider: "custom", status: "sent" });
    expect(driver.calls[0].idempotencyKey).toBe("k");

    driver.ok = false;
    const failed = await ReportEmail.send({ to: ["ada@example.com"], data: { name: "Ada" } });
    expect(failed.status).toBe("failed");
  });

  test("a replaced manager with only `send` still works", async () => {
    const send = vi.fn(async () => true);
    mail = { headers: {}, filterRecipients: (e: string[]) => e, send };

    const result = await ReportEmail.send({ to: ["ada@example.com"], data: { name: "Ada" } });

    expect(send).toHaveBeenCalledOnce();
    expect(result).toEqual({ id: null, provider: "custom", status: "sent" });
  });

  test("EMAIL_DEBUG records the key and returns a fake id", async () => {
    process.env.EMAIL_DEBUG = "true";
    const driver = new RecordingDriver();
    mail = new MailManager({ driver });

    const result = await ReportEmail.send({
      to: ["ada@example.com"],
      data: { name: "Ada" },
      idempotencyKey: "report:1:ada",
    });

    expect(result).toMatchObject({ provider: "debug", status: "debug" });
    expect(result.id).toMatch(/^debug_[0-9a-f-]{36}$/);
    expect(driver.sent).toHaveLength(0);

    const dir = join(root, ".debug/emails");
    const json = (await readdir(dir)).find((f) => f.endsWith(".json"))!;
    const record = JSON.parse(await readFile(join(dir, json), "utf8"));
    expect(record.idempotencyKey).toBe("report:1:ada");
  });
});

describe("ResendDriver", () => {
  const params: SendEmailParams = {
    from: "reports@example.com",
    to: ["ada@example.com"],
    subject: "Your report",
    cc: [],
    bcc: [],
    attachments: [],
    html: "<p>hi</p>",
  };

  test("sends the key as a request option, not in the message", async () => {
    resendSend.mockResolvedValue({ data: { id: "re_123" }, error: null });
    const driver = new ResendDriver("key");

    const result = await driver.deliver({ ...params, idempotencyKey: "report:1:ada" });

    expect(result).toEqual({ ok: true, id: "re_123" });
    expect(resendSend).toHaveBeenCalledWith(params, { idempotencyKey: "report:1:ada" });
    expect(resendSend.mock.calls[0][0]).not.toHaveProperty("idempotencyKey");
  });

  test("passes no options without a key", async () => {
    resendSend.mockResolvedValue({ data: { id: "re_123" }, error: null });

    await new ResendDriver("key").deliver(params);

    expect(resendSend).toHaveBeenCalledWith(params, undefined);
  });

  test("returns the error, and `send` keeps returning a boolean", async () => {
    const error = { name: "validation_error", message: "bad", statusCode: 422 };
    resendSend.mockResolvedValue({ data: null, error });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const driver = new ResendDriver("key");

    expect(await driver.deliver(params)).toEqual({ ok: false, id: null, error });
    expect(await driver.send(params)).toBe(false);

    resendSend.mockResolvedValue({ data: { id: "re_1" }, error: null });
    expect(await driver.send(params)).toBe(true);
    spy.mockRestore();
  });

  test("names its provider and supports keys", () => {
    const driver = new ResendDriver("key");
    expect(driver.provider).toBe("resend");
    expect(driver.supportsIdempotencyKey).toBe(true);
    expect(new LegacyDriver().supportsIdempotencyKey).toBe(false);
  });
});
