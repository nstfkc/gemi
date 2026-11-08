import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let store: any = undefined;
vi.mock("../../http/requestContext", () => ({
  RequestContext: { getStore: () => store },
}));

const { LogManager } = await import("./LogManager");
const { logConfigDefaults } = await import("./config");
const { consoleThreshold, formatConsoleLine } = await import("./consoleSink");

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  store = undefined;
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A manager that skips the file sink: `isReady` without a writer is the
 * "storage unavailable" path, so `log()` never touches the disk.
 */
function manager(config: Record<string, unknown>) {
  const m = new LogManager({ ...logConfigDefaults(), ...config } as any);
  m.isReady = true;
  return m;
}

const written = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((call) => String(call[0]));

describe("console sink", () => {
  test("is off when console is false", async () => {
    await manager({ console: false }).log("error", "boom");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  test("debug..notice go to stdout, warning and above to stderr", async () => {
    const m = manager({ console: true, consoleFormat: "json" });
    for (const level of [
      "debug",
      "info",
      "notice",
      "warning",
      "error",
      "critical",
      "alert",
      "emergency",
    ] as const) {
      await m.log(level, level);
    }
    expect(written(stdout).map((l) => JSON.parse(l).level)).toEqual([
      "debug",
      "info",
      "notice",
    ]);
    expect(written(stderr).map((l) => JSON.parse(l).level)).toEqual([
      "warning",
      "error",
      "critical",
      "alert",
      "emergency",
    ]);
  });

  test("a level writes that level and above", async () => {
    const m = manager({ console: "warning", consoleFormat: "json" });
    await m.log("info", "skipped");
    await m.log("notice", "skipped");
    await m.log("warning", "kept");
    await m.log("error", "kept");
    expect(stdout).not.toHaveBeenCalled();
    expect(written(stderr)).toHaveLength(2);
  });

  test("json: one line per entry, metadata flattened, core fields win", async () => {
    await manager({ console: true, consoleFormat: "json" }).log(
      "info",
      "Order created",
      { orderId: 7, level: "spoofed" },
    );
    const [line] = written(stdout);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      level: "info",
      message: "Order created",
      orderId: 7,
    });
    expect(typeof parsed.timestamp).toBe("string");
  });

  test("text: timestamp, level, message and metadata", async () => {
    await manager({ console: true, consoleFormat: "text" }).log(
      "error",
      "Payment failed",
      { orderId: 7 },
    );
    expect(written(stderr)[0]).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR Payment failed \{"orderId":7\}\n$/,
    );
  });

  test("errors keep their message and stack; circular values do not throw", async () => {
    const err = new Error("db down");
    const loop: any = { a: 1 };
    loop.self = loop;
    await manager({ console: true, consoleFormat: "json" }).log(
      "error",
      "failed",
      { err, loop, big: 10n },
    );
    const parsed = JSON.parse(written(stderr)[0]);
    expect(parsed.err.message).toBe("db down");
    expect(parsed.err.stack).toContain("db down");
    expect(parsed.loop.self).toBe("[Circular]");
    expect(parsed.big).toBe("10");
  });

  test("inside a request: method and path only, never headers", async () => {
    store = {
      req: {
        rawRequest: new Request("https://app.test/orders/7?token=secret", {
          method: "POST",
          headers: { cookie: "session=abc", authorization: "Bearer x" },
        }),
      },
    };
    const entries: any[] = [];
    await manager({
      console: true,
      consoleFormat: "json",
      onLogCreated: (entry: any) => entries.push(entry),
    }).log("info", "hit");
    const parsed = JSON.parse(written(stdout)[0]);
    expect(parsed.method).toBe("POST");
    expect(parsed.path).toBe("/orders/7");
    expect(written(stdout)[0]).not.toContain("secret");
    expect(written(stdout)[0]).not.toContain("session=abc");
    expect(parsed.headers).toBeUndefined();
    expect(entries[0].metadata.headers).toBeUndefined();
  });

  test("a throwing stream does not reach the caller", async () => {
    stdout.mockImplementation(() => {
      throw new Error("EPIPE");
    });
    await expect(
      manager({ console: true }).log("info", "x"),
    ).resolves.toBeUndefined();
  });
});

describe("request metadata (file sink and onLogCreated)", () => {
  const request = () =>
    new Request("https://app.test/orders/7?token=secret", {
      method: "POST",
      headers: {
        cookie: "session=abc",
        "set-cookie": "a=b",
        authorization: "Bearer x",
        "proxy-authorization": "Basic y",
        "x-api-key": "key",
        "x-tenant-secret": "t",
        "user-agent": "Agent/1.0",
        "x-request-id": "req-1",
        accept: "text/html",
      },
      body: "password=hunter2",
    });

  async function entryFor(config: Record<string, unknown>) {
    store = { req: { rawRequest: request() } };
    const entries: any[] = [];
    await manager({
      console: false,
      onLogCreated: (entry: any) => entries.push(entry),
      ...config,
    }).log("info", "hit", { orderId: 7 });
    return entries[0];
  }

  test("by default: method, path, user agent and request id only", async () => {
    const entry = await entryFor({});
    expect(entry.metadata).toEqual({
      method: "POST",
      path: "/orders/7",
      userAgent: "Agent/1.0",
      requestId: "req-1",
      orderId: 7,
    });
    expect(JSON.stringify(entry)).not.toMatch(
      /session=abc|Bearer|secret|hunter2/,
    );
  });

  test("no request id key without an x-request-id header", async () => {
    store = { req: { rawRequest: new Request("https://app.test/") } };
    const entries: any[] = [];
    await manager({ onLogCreated: (e: any) => entries.push(e) }).log(
      "info",
      "x",
    );
    expect(entries[0].metadata).not.toHaveProperty("requestId");
  });

  test("requestFields opts into the url and redacted headers", async () => {
    const entry = await entryFor({
      requestFields: ["url", "headers"],
      redactHeaders: ["X-Tenant-Secret"],
    });
    expect(entry.metadata.url).toBe("https://app.test/orders/7?token=secret");
    expect(entry.metadata.headers).toMatchObject({
      cookie: "[redacted]",
      "set-cookie": "[redacted]",
      authorization: "[redacted]",
      "proxy-authorization": "[redacted]",
      "x-api-key": "[redacted]",
      "x-tenant-secret": "[redacted]",
      accept: "text/html",
      "user-agent": "Agent/1.0",
    });
    expect(JSON.stringify(entry)).not.toMatch(/session=abc|Bearer|hunter2/);
  });

  test("the default redactions cannot be turned off", async () => {
    const entry = await entryFor({
      requestFields: ["headers"],
      redactHeaders: [],
    });
    expect(entry.metadata.headers.cookie).toBe("[redacted]");
    expect(entry.metadata.headers.authorization).toBe("[redacted]");
  });
});

describe("defaults", () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  test("on with text lines in development", () => {
    process.env.NODE_ENV = "development";
    expect(logConfigDefaults()).toMatchObject({
      console: true,
      consoleFormat: "text",
    });
  });

  test("off with json lines in production", () => {
    process.env.NODE_ENV = "production";
    expect(logConfigDefaults()).toMatchObject({
      console: false,
      consoleFormat: "json",
    });
  });
});

describe("consoleThreshold", () => {
  test("maps options to the lowest level written", () => {
    expect(consoleThreshold(false)).toBe(-1);
    expect(consoleThreshold(undefined)).toBe(-1);
    expect(consoleThreshold(true)).toBe(0);
    expect(consoleThreshold("warning")).toBe(3);
    expect(consoleThreshold("bogus" as any)).toBe(0);
  });

  test("text without metadata has no trailing object", () => {
    expect(
      formatConsoleLine(
        { timestamp: "t", level: "info", message: "m", metadata: {} },
        "text",
      ),
    ).toBe("t INFO m");
  });
});
