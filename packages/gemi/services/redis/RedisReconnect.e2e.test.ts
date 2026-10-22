import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { RedisRateLimiter } from "../rate-limiter/drivers/RedisRateLimiterDriver";
import { RedisManager } from "./RedisManager";

/**
 * #982 on a real Redis that goes away and comes back: a throwaway Docker
 * container this file starts, pauses, stops, starts again and removes.
 *
 * Before the fix, once Bun's client gave up on the connection, `RedisManager`
 * kept handing out that dead client, so `RedisRateLimiter` failed open on every
 * call until the process restarted; and each call meanwhile waited out the
 * client's connect timeout and reconnect loop.
 *
 * Runs when `TEST_REDIS_DOCKER=1` and `docker` works (CI's `redis` job sets
 * it); skipped loudly otherwise, and failed instead when `CI_REDIS_REQUIRED=1`.
 */

const IMAGE = process.env.TEST_REDIS_IMAGE ?? "public.ecr.aws/docker/library/redis:7-alpine";

/** The per-call limit the limiters below run with, and how far past it a call may finish. */
const TIMEOUT = 250;
const SLACK = 400;

if (process.env.TEST_REDIS_DOCKER !== "1") {
  describe("Redis outage and recovery", () => {
    const name = "did NOT run: set TEST_REDIS_DOCKER=1 (needs docker)";
    if (process.env.CI_REDIS_REQUIRED === "1") {
      test(name, () => {
        throw new Error("This run must reach Docker. Not set: TEST_REDIS_DOCKER=1.");
      });
    } else {
      test.skip(name, () => {});
    }
  });
} else {
  suite();
}

function docker(...args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitFor<T>(label: string, check: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}

function suite() {
  describe("Redis outage and recovery", () => {
    const name = `gemi-test-redis-${randomBytes(4).toString("hex")}`;
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const url = `redis://127.0.0.1:${port}`;

    // Bun's defaults (10 s connect timeout, 10 retries) would take half a
    // minute to give up; these get the client to the "gave up" state in a
    // couple of seconds, which is the state #982 is about.
    const manager = new RedisManager({ url, options: { connectionTimeout: 1_000, maxRetries: 2 } });
    const application = new Application();
    application.singleton(RedisManager, () => manager);

    const prefix = `gemi-test:${randomBytes(4).toString("hex")}`;
    const errors: unknown[] = [];
    const open = new RedisRateLimiter({ prefix, timeout: TIMEOUT, onRedisError: "open", onError: (e) => errors.push(e) });
    const closed = new RedisRateLimiter({ prefix, timeout: TIMEOUT, onRedisError: "closed", onError: (e) => errors.push(e) });

    let keyN = 0;
    const freshKey = () => `k${++keyN}`;

    async function timed(limiter: RedisRateLimiter, key: string, limit = 2) {
      const started = performance.now();
      const result = await kernelContext.run(application, () =>
        limiter.consume({ key, limit, window: 60_000 }),
      );
      return { result, ms: performance.now() - started };
    }

    /** Whether a limit of 1 is enforced on a fresh key, i.e. Redis is counting. */
    async function enforced() {
      const key = freshKey();
      const first = await timed(closed, key, 1);
      const second = await timed(closed, key, 1);
      return first.result.allowed && !second.result.allowed ? true : undefined;
    }

    /** What Redis holds for `key` over the current and the previous minute, read on a client of its own. */
    async function countedInRedis(key: string) {
      const reader = new (globalThis as any).Bun.RedisClient(url, { connectionTimeout: 1_000, maxRetries: 0 });
      try {
        const bucket = Math.floor(Date.now() / 60_000);
        let total = 0;
        for (const b of [bucket, bucket - 1]) total += Number((await reader.send("GET", [`${prefix}:${key}:${b}`])) ?? 0);
        return total;
      } finally {
        reader.close();
      }
    }

    /**
     * #1011: an outage is counted in memory, and none of its calls reach Redis
     * once it is back. Before, Bun's offline queue (after a kill) or the stalled
     * socket (after a pause) ran every increment of the outage on recovery.
     */
    async function outageIsNotReplayed(
      on: Application,
      during: () => Promise<void>,
      recover: () => void,
    ) {
      const memory = new RedisRateLimiter({ prefix, timeout: TIMEOUT, onError: () => {} });
      const key = freshKey();
      const consume = async (limit: number) => {
        const started = performance.now();
        const result = await kernelContext.run(on, () => memory.consume({ key, limit, window: 60_000 }));
        return { result, ms: performance.now() - started };
      };
      expect((await consume(1_000)).result.allowed).toBe(true);

      await during();
      for (let i = 0; i < 20; i++) {
        const { result, ms } = await consume(1_000);
        expect(result.allowed).toBe(true);
        expect(ms).toBeLessThan(TIMEOUT + SLACK);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Counted in memory: its budget starts empty, so a limit of 3 refuses
      // the outage's 21st call.
      expect((await consume(3)).result.allowed).toBe(false);

      recover();
      // Back on Redis: a fresh limit of 1 is enforced again.
      await waitFor(
        "the limiter to count in Redis again",
        async () => {
          const probe = freshKey();
          const run = (limit: number) =>
            kernelContext.run(on, () => memory.consume({ key: probe, limit, window: 60_000 }));
          await run(1_000);
          return (await countedInRedis(probe)) === 1 ? true : undefined;
        },
        30_000,
      );
      // Let anything still queued or stuck on a socket land.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // The call before the outage, plus at most the one sent into it before
      // the first failure was seen: not 21.
      expect(await countedInRedis(key)).toBeLessThanOrEqual(2);
    }

    beforeAll(async () => {
      docker("run", "-d", "--name", name, "-p", `127.0.0.1:${port}:6379`, IMAGE);
      // A new probe each time: a Bun client that failed once stays failed,
      // which is this whole file's subject.
      await waitFor("redis to start", async () => {
        const probe = new (globalThis as any).Bun.RedisClient(url, { connectionTimeout: 500, maxRetries: 0 });
        try {
          return (await probe.send("PING", [])) === "PONG" ? true : undefined;
        } finally {
          probe.close();
        }
      });
    }, 120_000);

    afterAll(() => {
      manager.close();
      try {
        docker("rm", "-f", name);
      } catch {}
    });

    test("limits apply while Redis is up", async () => {
      expect(await enforced()).toBe(true);
    });

    test("a Redis that stops answering costs each call at most the timeout", async () => {
      docker("pause", name);
      try {
        for (let i = 0; i < 3; i++) {
          const a = await timed(open, freshKey());
          expect(a.result.allowed).toBe(true);
          expect(a.ms).toBeLessThan(TIMEOUT + SLACK);

          const b = await timed(closed, freshKey());
          expect(b.result.allowed).toBe(false);
          expect(b.ms).toBeLessThan(TIMEOUT + SLACK);
        }
      } finally {
        docker("unpause", name);
      }
      expect(await waitFor("limits after unpause", enforced)).toBe(true);
    }, 60_000);

    test("a paused Redis: counted in memory, not replayed once it answers", async () => {
      let paused = false;
      try {
        await outageIsNotReplayed(
          application,
          async () => {
            docker("pause", name);
            paused = true;
          },
          () => {
            docker("unpause", name);
            paused = false;
          },
        );
      } finally {
        if (paused) docker("unpause", name);
      }
    }, 60_000);

    // Skipped on Linux: there, Bun (1.3.14) comes back from its own reconnect
    // after a kill that caught a command in flight with a connection that
    // reports `connected` and never answers again, so no limiter on it can
    // recover until the client is replaced. That is a separate problem
    // (#1016); the pause above covers the replay on Linux.
    test.skipIf(process.platform === "linux")("a killed Redis: counted in memory, Bun's reconnect does not replay it", async () => {
      // A client that keeps reconnecting through the outage (rather than
      // giving up as `manager`'s does), so its offline queue is still holding
      // commands when Redis comes back.
      const patient = new RedisManager({ url, options: { connectionTimeout: 1_000, maxRetries: 1_000 } });
      const on = new Application();
      on.singleton(RedisManager, () => patient);
      try {
        await waitFor("the patient client to connect", async () => {
          await patient.client.send("PING", []);
          return patient.client.connected ? true : undefined;
        });
        await outageIsNotReplayed(
          on,
          async () => {
            docker("stop", "-t", "0", name);
          },
          () => {
            docker("start", name);
          },
        );
      } finally {
        patient.close();
      }
    }, 90_000);

    test("after Redis is killed and the client gives up, limits come back once Redis does", async () => {
      const client = manager.client;
      errors.length = 0;
      docker("stop", "-t", "0", name);

      // Calls stay bounded through the whole outage, including while the
      // client times out and runs through its retries.
      const outageEnds = Date.now() + 4_000;
      while (Date.now() < outageEnds) {
        const { result, ms } = await timed(open, freshKey());
        expect(result.allowed).toBe(true);
        expect(ms).toBeLessThan(TIMEOUT + SLACK);
        // A limiter that is down answers without I/O; let its background
        // PING (and its timeout) run, as requests arriving over the network would.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(errors.length).toBeGreaterThan(0);
      expect(client.connected).toBe(false);

      docker("start", name);

      // No process restart: the same manager counts again once Redis is back,
      // on a client it built to replace the one that gave up.
      expect(await waitFor("limits after restart", enforced, 30_000)).toBe(true);
      expect(manager.client).not.toBe(client);
      expect(manager.client.connected).toBe(true);
    }, 90_000);
  });
}
