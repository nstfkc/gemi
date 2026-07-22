import { Controller, type FileOutput, type HttpRequest } from "gemi/http";

export class FileController extends Controller {
  /**
   * Controller handlers work the same as inline callbacks — return anything
   * assignable to `FileOutput`.
   */
  async invoice(req: HttpRequest<any, { id: string }>): Promise<FileOutput> {
    const { id } = req.params;

    const lines = ["INVOICE", "=======", `Number: ${id}`, "Customer: Acme Inc.", "Total: $42.00"];

    return {
      file: lines.join("\n"),
      name: `invoice-${id}.txt`,
      type: "text/plain; charset=utf-8",
      download: true,
    };
  }
}
