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
    const open = new RedisRateLimiter({ prefix, timeout: TIMEOUT, onError: (e) => errors.push(e) });
    const closed = new RedisRateLimiter({ prefix, timeout: TIMEOUT, failOpen: false, onError: (e) => errors.push(e) });

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
