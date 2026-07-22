import { describe, expect, test } from "vitest";
import { createFileResponse, type HttpRequest } from "gemi/http";

import { FilesRouter } from "./files";

const routes = new FilesRouter().routes;

// `Bun.file()` routes only run under `bun test`, not under vitest's node runner.
const bunOnly = typeof Bun === "undefined";

/**
 * Runs a file route the way ViewRouterServiceContainer does: execute the
 * handler, pull the FILE key off the result, turn it into a Response.
 */
async function get(routePath: keyof typeof routes, params: Record<string, string> = {}) {
  const route = routes[routePath] as any;
  const req = { params } as unknown as HttpRequest<any, any>;
  const { FILE } = await route.run(req, routePath);

  return await createFileResponse(FILE, new Headers());
}

describe("file routes", () => {
  test("file routes are tagged FILE, the index stays a view", () => {
    expect((routes["/"] as any).viewPath).toBe("Files");
    expect((routes["/report.csv"] as any).viewPath).toBe("FILE");
    expect((routes["/invoices/:id"] as any).viewPath).toBe("FILE");
  });

  test.skipIf(bunOnly)("streams a file from disk", async () => {
    const res = await get("/logo.svg");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(Number(res.headers.get("Content-Length"))).toBeGreaterThan(0);
    expect(await res.text()).toContain("<svg");
  });

  test.skipIf(bunOnly)("404s instead of streaming a missing file", async () => {
    const res = await get("/missing.pdf");
    expect(res.status).toBe(404);
  });

  test("sends generated content as a download", async () => {
    const res = await get("/report.csv");

    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(`filename="report.csv"`);
    expect(await res.text()).toBe("id,plan,mrr\n1,pro,49\n2,team,199");
  });

  test("reads name and type off a bare File", async () => {
    const res = await get("/hello.txt");

    // Bun normalises this to "text/plain;charset=utf-8", node keeps it bare.
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Content-Disposition")).toContain(`filename="hello.txt"`);
    expect(await res.text()).toBe("hello from gemi");
  });

  test("runs a controller handler with route params", async () => {
    const res = await get("/invoices/:id", { id: "1042" });

    expect(res.headers.get("Content-Disposition")).toContain(`filename="invoice-1042.txt"`);
    expect(await res.text()).toContain("Number: 1042");
  });

  test("passes a Response through untouched", async () => {
    const res = await get("/raw");

    expect(res.headers.get("X-Example")).toBe("passthrough");
    expect(await res.text()).toBe("raw response, headers untouched");
  });
});
