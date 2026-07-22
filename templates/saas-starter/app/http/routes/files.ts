import { ViewRouter } from "gemi/http";
import { FileController } from "../controllers/FileController";

/**
 * Examples for `this.file(...)`. A file route has no component — it resolves to
 * a raw response, so link to it with a plain <a>, not <Link>.
 */
export class FilesRouter extends ViewRouter {
  routes = {
    // Index page linking to every example below.
    "/": this.view("Files"),

    // A file on disk. `Bun.file()` is lazy, so a missing path becomes a clean
    // 404 instead of a stream that dies after the response is committed.
    "/logo.svg": this.file(() => Bun.file("public/logo.svg")),
    "/missing.pdf": this.file(() => Bun.file("public/does-not-exist.pdf")),

    // Generated content, sent as a download.
    "/report.csv": this.file(() => {
      const rows = [
        ["id", "plan", "mrr"],
        ["1", "pro", "49"],
        ["2", "team", "199"],
      ];

      return {
        file: rows.map((row) => row.join(",")).join("\n"),
        name: "report.csv",
        type: "text/csv",
        download: true,
        headers: { "Cache-Control": "no-store" },
      };
    }),

    // A bare Blob/File — name and type are read off the instance.
    "/hello.txt": this.file(
      () => new File(["hello from gemi"], "hello.txt", { type: "text/plain" }),
    ),

    // Controller handler, with route params.
    "/invoices/:id": this.file([FileController, "invoice"]),

    // Returning a Response passes it through untouched.
    "/raw": this.file(
      () =>
        new Response("raw response, headers untouched", {
          status: 200,
          headers: { "Content-Type": "text/plain", "X-Example": "passthrough" },
        }),
    ),
  };
}
