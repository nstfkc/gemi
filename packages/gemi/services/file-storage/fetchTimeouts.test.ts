import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { Storage } from "../../facades/Storage";
import { AzureBlobDriver } from "./drivers/AzureBlobDriver";
import { FileStorageDriver } from "./drivers/FileStorageDriver";
import { S3Driver } from "./drivers/S3Driver";
import { StorageFetchTimeoutError } from "./fetchTimeouts";
import { FilesystemManager } from "./FilesystemManager";

const LIMIT = 200;

/**
 * A raw TCP server, so the tests control exactly when headers and body bytes
 * go out. `respond` runs once per connection, on its first request bytes.
 */
async function tcpServer(respond: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const closed: Promise<void>[] = [];
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
    socket.on("error", () => {});
    socket.once("data", () => respond(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  servers.push({ server, sockets });
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => sockets.size,
    /** Resolves once every connection the server saw has been closed. */
    allClosed: () => Promise.all(closed),
  };
}

const servers: { server: Server; sockets: Set<Socket> }[] = [];

// The S3 driver loads its SDK on first use. Under a loaded test run that
// import alone can take longer than LIMIT, which would fire the timeout before
// any connection is made.
beforeAll(async () => {
  await import("@aws-sdk/client-s3");
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { server, sockets } of servers.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function headers(length: number) {
  return `HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${length}\r\n\r\n`;
}

/** Accepts the connection and never answers: the issue's setup. */
const silent = () => {};

/** Sends the headers and the first 10 of 100 bytes, then nothing. */
const stallsAfterHeaders = (socket: Socket) => {
  socket.write(headers(100) + "x".repeat(10));
};

/** 10 chunks, one every LIMIT / 3 ms: longer in total than the idle limit. */
const CHUNKS = 10;
const steady = (socket: Socket) => {
  socket.write(headers(CHUNKS));
  let sent = 0;
  const timer = setInterval(() => {
    socket.write("y");
    if (++sent === CHUNKS) clearInterval(timer);
  }, LIMIT / 3);
  socket.once("close", () => clearInterval(timer));
};

function s3(url: string) {
  return new S3Driver({
    region: "us-east-1",
    endpoint: url,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

/**
 * `@azure/storage-blob` is an optional peer and not installed here, so the
 * client is a stand-in that does what the SDK does: a real HTTP request that
 * honours `abortSignal`, handing back the body as a Node stream.
 */
function azure(url: string) {
  return new AzureBlobDriver({
    container: "c",
    serviceClient: {
      getContainerClient: () => ({
        getBlockBlobClient: (name: string) => ({
          async download(_offset?: number, _count?: number, options?: { abortSignal?: AbortSignal }) {
            const res = await fetch(`${url}/c/${name}`, { signal: options?.abortSignal });
            return {
              readableStreamBody: Readable.fromWeb(res.body as any),
              contentLength: Number(res.headers.get("Content-Length")),
              contentType: res.headers.get("Content-Type") ?? undefined,
            };
          },
        }),
      }),
    } as any,
  });
}

const drivers = [
  ["S3Driver", s3],
  ["AzureBlobDriver", azure],
] as const;

function useDriver(driver: FileStorageDriver, limits = { fetchTimeoutMs: LIMIT, fetchIdleTimeoutMs: LIMIT }) {
  vi.spyOn(Storage, "getFacadeRoot").mockReturnValue(
    new FilesystemManager({ driver, ...limits }),
  );
}

async function elapsed<T>(work: Promise<T>) {
  const start = performance.now();
  const result = await work.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  return { ...result, ms: performance.now() - start };
}

describe.each(drivers)("Storage.fetch() default limits on %s", (name, make) => {
  test("a server that never answers rejects at about fetchTimeoutMs and the socket is released", async () => {
    const server = await tcpServer(silent);
    useDriver(make(server.url));

    const { error, ms } = await elapsed(Storage.fetch({ name: "a.bin", bucket: "c" }));

    expect(error).toBeInstanceOf(StorageFetchTimeoutError);
    expect(error).toMatchObject({ driver: name, limit: "fetchTimeoutMs", timeoutMs: LIMIT });
    expect(error.message).toContain(name);
    expect(error.message).toContain("fetchTimeoutMs");
    expect(ms).toBeGreaterThanOrEqual(LIMIT - 20);
    expect(ms).toBeLessThan(LIMIT + 1000);
    expect(server.connections()).toBe(1);
    await server.allClosed();
  });

  test("headers then a stalled body errors the body at about fetchIdleTimeoutMs", async () => {
    const server = await tcpServer(stallsAfterHeaders);
    useDriver(make(server.url));

    const res = await Storage.fetch({ name: "a.bin", bucket: "c" });
    const { error, ms } = await elapsed(res.arrayBuffer());

    expect(error).toBeInstanceOf(StorageFetchTimeoutError);
    expect(error).toMatchObject({ driver: name, limit: "fetchIdleTimeoutMs", timeoutMs: LIMIT });
    expect(ms).toBeGreaterThanOrEqual(LIMIT - 20);
    expect(ms).toBeLessThan(LIMIT + 1000);
    await server.allClosed();
  });

  test("a slow but steady body longer than fetchIdleTimeoutMs completes", async () => {
    const server = await tcpServer(steady);
    useDriver(make(server.url));

    const res = await Storage.fetch({ name: "a.bin", bucket: "c" });
    const { value, error, ms } = await elapsed(res.text());

    expect(error).toBeUndefined();
    expect(value).toBe("y".repeat(CHUNKS));
    expect(ms).toBeGreaterThan(LIMIT * 2);
  });

  test("a caller's signal turns the defaults off", async () => {
    const server = await tcpServer(silent);
    useDriver(make(server.url));
    const controller = new AbortController();

    const pending = elapsed(Storage.fetch({ name: "a.bin", bucket: "c" }, { signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, LIMIT * 3));
    controller.abort(new Error("caller gave up"));
    const { error, ms } = await pending;

    expect(error).not.toBeInstanceOf(StorageFetchTimeoutError);
    expect(ms).toBeGreaterThanOrEqual(LIMIT * 3 - 20);
  });
});

describe("Storage.fetch() default limits on any driver", () => {
  test("a driver that ignores the signal is still cut at fetchTimeoutMs", async () => {
    class Hangs extends FileStorageDriver {
      fetch = () => new Promise<Response>(() => {});
      put = async () => "";
      list = async () => [];
    }
    useDriver(new Hangs());

    const { error } = await elapsed(Storage.fetch("a.bin"));

    expect(error).toMatchObject({ name: "StorageFetchTimeoutError", driver: "Hangs", object: "a.bin" });
  });

  test("a body the driver never feeds is cut at fetchIdleTimeoutMs, and the source is cancelled", async () => {
    const cancel = vi.fn();
    class Stalls extends FileStorageDriver {
      fetch = async () => new Response(new ReadableStream({ cancel }));
      put = async () => "";
      list = async () => [];
    }
    useDriver(new Stalls());

    const res = await Storage.fetch("a.bin");

    await expect(res.text()).rejects.toMatchObject({ limit: "fetchIdleTimeoutMs" });
    expect(cancel).toHaveBeenCalledWith(expect.any(StorageFetchTimeoutError));
  });

  test("a slow consumer is not cut: the idle clock only runs while a read waits", async () => {
    class Instant extends FileStorageDriver {
      fetch = async () => new Response("abc");
      put = async () => "";
      list = async () => [];
    }
    useDriver(new Instant());

    const res = await Storage.fetch("a.bin");
    await new Promise((resolve) => setTimeout(resolve, LIMIT * 2));

    expect(await res.text()).toBe("abc");
  });

  test("0 turns a limit off", async () => {
    class Hangs extends FileStorageDriver {
      fetch = vi.fn(() => new Promise<Response>(() => {}));
      put = async () => "";
      list = async () => [];
    }
    const driver = new Hangs();
    useDriver(driver, { fetchTimeoutMs: 0, fetchIdleTimeoutMs: 0 });

    const result = await Promise.race([
      Storage.fetch("a.bin").then(() => "settled", () => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), LIMIT * 2)),
    ]);

    expect(result).toBe("pending");
    expect(driver.fetch).toHaveBeenCalledWith("a.bin", {});
  });

  test("defaults to 30s for both limits", () => {
    const manager = new FilesystemManager({});
    expect(manager.fetchTimeoutMs).toBe(30_000);
    expect(manager.fetchIdleTimeoutMs).toBe(30_000);
  });
});
