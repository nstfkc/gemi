import { describe, test, expect } from "vitest";
import { createFileResponse, FileRoute, ViewRouter } from "./ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";

class FileRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/invoice.pdf": this.file(
      () => new File(["hello"], "invoice.pdf", { type: "application/pdf" }),
    ),
  };
}

describe("ViewRouter.file()", () => {
  test("creates a FileRoute", () => {
    const routes = new FileRouter().routes;
    expect(routes["/invoice.pdf"]).toBeInstanceOf(FileRoute);
    expect(routes["/invoice.pdf"].viewPath).toBe("FILE");
  });

  test("is excluded from the component tree", () => {
    expect(createComponentTree(new FileRouter().routes)).toEqual([["Home", []]]);
  });

  test("run() returns the file under the FILE key", async () => {
    const route = new FileRouter().routes["/invoice.pdf"] as FileRoute<any, any>;
    const result = await route.run({} as any, "/invoice.pdf");
    expect((result.FILE as File).name).toBe("invoice.pdf");
  });

  test("run() throws when the handler returns nothing", async () => {
    const route = new FileRoute(() => undefined as any);
    expect(route.run({} as any, "/nope")).rejects.toThrow();
  });
});

describe("createFileResponse()", () => {
  test("streams a blob with inline disposition", async () => {
    const file = new File(["hello"], "invoice.pdf", { type: "application/pdf" });
    const res = await createFileResponse(file, new Headers());

    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Length")).toBe("5");
    expect(res.headers.get("Content-Disposition")).toBe(
      `inline; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`,
    );
    expect(await res.text()).toBe("hello");
  });

  test("supports the descriptor form", async () => {
    const res = await createFileResponse(
      {
        file: "id,name\n1,gemi",
        name: "réport.csv",
        type: "text/csv",
        download: true,
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
      new Headers(),
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="r_port.csv"; filename*=UTF-8''r%C3%A9port.csv`,
    );
    expect(await res.text()).toBe("id,name\n1,gemi");
  });

  test("falls back to application/octet-stream", async () => {
    const res = await createFileResponse({ file: "raw" }, new Headers());
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe(null);
  });

  test("passes a Response through untouched", async () => {
    const original = new Response("ok", { status: 418 });
    expect(await createFileResponse(original, new Headers())).toBe(original);
  });

  test("404s when a lazy file does not exist", async () => {
    const missing = Object.assign(new Blob(["x"]), { exists: async () => false });
    const res = await createFileResponse(missing, new Headers());
    expect(res.status).toBe(404);
  });
});
