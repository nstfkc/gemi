import { describe, expect, test, vi } from "vitest";
import {
  AcsDriver,
  parseAcsAddress,
  type AcsEmailClientLike,
  type AcsEmailMessage,
} from "./AcsDriver";
import type { SendEmailParams } from "./types";

/** A fake `EmailClient`: records what it was handed, never touches the network. */
function fakeClient(
  poller: Awaited<ReturnType<AcsEmailClientLike["beginSend"]>> = {
    getOperationState: () => ({ status: "running" }),
    getResult: () => undefined,
  },
) {
  const calls: Array<{ message: AcsEmailMessage; options?: { operationId?: string } }> = [];
  const client: AcsEmailClientLike = {
    beginSend: vi.fn(async (message, options) => {
      calls.push({ message, options });
      return poller;
    }),
  };
  return { client, calls };
}

function params(overrides: Partial<SendEmailParams> = {}): SendEmailParams {
  return {
    from: "Folio <updates@transactional.example.com>",
    to: ["ada@example.com", "Grace Hopper <grace@example.com>"],
    cc: [],
    bcc: [],
    subject: "Your report",
    html: "<p>Hi</p>",
    attachments: [],
    ...overrides,
  };
}

describe("AcsDriver", () => {
  test("maps every field of SendEmailParams to the ACS message", async () => {
    const { client, calls } = fakeClient();
    const driver = new AcsDriver({ client });

    await driver.deliver(
      params({
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        replyTo: ["Support <support@example.com>"],
        text: "Hi",
        headers: { "In-Reply-To": "<m1@example.com>", "List-Unsubscribe": "<https://x/u>" },
        attachments: [
          { filename: "report.csv", content: Buffer.from("a,b\n") },
          { filename: "blob", content: Buffer.from("x"), contentType: "application/pdf" },
          { filename: "noext", content: Buffer.from("y") },
        ],
      }),
    );

    expect(calls[0].message).toEqual({
      senderAddress: "updates@transactional.example.com",
      content: { subject: "Your report", html: "<p>Hi</p>", plainText: "Hi" },
      recipients: {
        to: [
          { address: "ada@example.com" },
          { address: "grace@example.com", displayName: "Grace Hopper" },
        ],
        cc: [{ address: "cc@example.com" }],
        bcc: [{ address: "bcc@example.com" }],
      },
      replyTo: [{ address: "support@example.com", displayName: "Support" }],
      headers: { "In-Reply-To": "<m1@example.com>", "List-Unsubscribe": "<https://x/u>" },
      attachments: [
        {
          name: "report.csv",
          contentType: "text/csv",
          contentInBase64: Buffer.from("a,b\n").toString("base64"),
        },
        { name: "blob", contentType: "application/pdf", contentInBase64: "eA==" },
        { name: "noext", contentType: "application/octet-stream", contentInBase64: "eQ==" },
      ],
    });
  });

  test("leaves out empty optional fields", async () => {
    const { client, calls } = fakeClient();
    await new AcsDriver({ client }).deliver(params({ headers: {} }));

    expect(calls[0].message).toEqual({
      senderAddress: "updates@transactional.example.com",
      content: { subject: "Your report", html: "<p>Hi</p>" },
      recipients: {
        to: [
          { address: "ada@example.com" },
          { address: "grace@example.com", displayName: "Grace Hopper" },
        ],
      },
    });
  });

  test("returns the operation id without waiting for completion", async () => {
    const pollUntilDone = vi.fn();
    const { client, calls } = fakeClient({
      getOperationState: () => ({ status: "running" }),
      getResult: () => undefined,
      pollUntilDone,
    } as any);

    const result = await new AcsDriver({ client }).deliver(params());

    const operationId = calls[0].options?.operationId;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result).toEqual({ ok: true, id: operationId });
    expect(pollUntilDone).not.toHaveBeenCalled();
  });

  test("prefers the id ACS reports once it has one", async () => {
    const { client } = fakeClient({
      getOperationState: () => ({ status: "succeeded" }),
      getResult: () => ({ id: "acs-op-1" }),
    });

    expect(await new AcsDriver({ client }).deliver(params())).toEqual({
      ok: true,
      id: "acs-op-1",
    });
  });

  test("reports a rejected request as failed", async () => {
    const error = Object.assign(new Error("Invalid sender"), { statusCode: 400 });
    const client: AcsEmailClientLike = { beginSend: vi.fn().mockRejectedValue(error) };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await new AcsDriver({ client }).deliver(params())).toEqual({
      ok: false,
      id: null,
      error,
    });
    expect(await new AcsDriver({ client }).send(params())).toBe(false);
    spy.mockRestore();
  });

  test("reports an operation that already failed", async () => {
    const error = { code: "Denied" };
    const { client, calls } = fakeClient({
      getOperationState: () => ({ status: "failed", error }),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await new AcsDriver({ client }).deliver(params());
    expect(result).toEqual({ ok: false, id: calls[0].options?.operationId, error });
    spy.mockRestore();
  });

  test("refuses scheduledAt", async () => {
    const { client } = fakeClient();
    await expect(
      new AcsDriver({ client }).deliver(params({ scheduledAt: "in 3 min" })),
    ).rejects.toThrow(/can't schedule a send.*delayed job/);
    expect(client.beginSend).not.toHaveBeenCalled();
  });

  test("ignores idempotency keys", async () => {
    const { client, calls } = fakeClient();
    const driver = new AcsDriver({ client });
    expect(driver.supportsIdempotencyKey).toBe(false);
    expect(driver.provider).toBe("acs");

    await driver.deliver(params({ idempotencyKey: "k" }));
    expect(JSON.stringify(calls[0])).not.toContain('"k"');
  });

  test("without a client, endpoint or connection string, says what it needs", async () => {
    const env = { ...process.env };
    delete process.env.AZURE_COMMUNICATION_ENDPOINT;
    delete process.env.AZURE_COMMUNICATION_CONNECTION_STRING;
    vi.doMock("@azure/communication-email", () => ({ EmailClient: class {} }));
    try {
      await expect(new AcsDriver().deliver(params())).rejects.toThrow(
        /AZURE_COMMUNICATION_ENDPOINT.*AZURE_COMMUNICATION_CONNECTION_STRING/,
      );
    } finally {
      vi.doUnmock("@azure/communication-email");
      process.env = env;
    }
  });

  test("uses DefaultAzureCredential with an endpoint, the connection string otherwise", async () => {
    const constructed: unknown[][] = [];
    class EmailClient {
      constructor(...args: unknown[]) {
        constructed.push(args);
      }
      async beginSend() {
        return {};
      }
    }
    class DefaultAzureCredential {}
    vi.doMock("@azure/communication-email", () => ({ EmailClient }));
    vi.doMock("@azure/identity", () => ({ DefaultAzureCredential }));
    try {
      await new AcsDriver({
        endpoint: "https://acs.example.communication.azure.com",
        connectionString: "endpoint=https://x/;accesskey=y",
      }).deliver(params());
      await new AcsDriver({ connectionString: "endpoint=https://x/;accesskey=y" }).deliver(
        params(),
      );

      expect(constructed[0][0]).toBe("https://acs.example.communication.azure.com");
      expect(constructed[0][1]).toBeInstanceOf(DefaultAzureCredential);
      expect(constructed[1]).toEqual(["endpoint=https://x/;accesskey=y"]);
    } finally {
      vi.doUnmock("@azure/communication-email");
      vi.doUnmock("@azure/identity");
    }
  });
});

describe("parseAcsAddress", () => {
  test.each([
    ["ada@example.com", { address: "ada@example.com" }],
    ["<ada@example.com>", { address: "ada@example.com" }],
    ["Ada <ada@example.com>", { address: "ada@example.com", displayName: "Ada" }],
    ['"Lovelace, Ada" <ada@example.com>', { address: "ada@example.com", displayName: "Lovelace, Ada" }],
  ])("%s", (input, expected) => {
    expect(parseAcsAddress(input)).toEqual(expected);
  });
});
