import { afterEach, describe, expect, test, vi } from "vitest";
import { Application } from "../foundation/Application";
import { app } from "../foundation/app";
import { Kernel } from "../kernel";
import { Repository } from "../support/Repository";
import { ServiceProvider } from "../support/ServiceProvider";
import { Server } from "./Server";
import { resetShuttingDown } from "./shutdown";

// `start()` needs a built `dist/` (production) or Vite (development), so this
// covers what `stop()` owns without it: that it reaches the application's
// providers, inside the application context, and only once. The drain itself
// is `shutdown.test.ts`.
const calls: string[] = [];

class First extends ServiceProvider {
  shutdown() {
    calls.push("First");
  }
}

class Second extends ServiceProvider {
  async shutdown() {
    // A hook reaches the container the way a request or a cron tick does.
    calls.push(`Second sees config: ${app(Repository) === this.app.config}`);
  }
}

class TestKernel extends Kernel {
  protected providers = [First, Second];
}

afterEach(() => {
  calls.length = 0;
  resetShuttingDown();
  Application.setInstance(undefined);
  vi.restoreAllMocks();
});

describe("Server.stop", () => {
  test("shuts the app's providers down in reverse order, in the application context, once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = new Server({ kernel: TestKernel, handleSignals: false });
    // `app()` falls back to the last-booted Application outside a context;
    // clear it, so only the kernel's own context can answer.
    Application.setInstance(undefined);

    const [first, second] = await Promise.all([server.stop(), server.stop()]);

    expect(calls).toEqual(["Second sees config: true", "First"]);
    expect([first, second]).toEqual([0, 0]);
  });
});
