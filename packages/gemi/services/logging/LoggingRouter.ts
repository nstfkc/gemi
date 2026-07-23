import { ApiRouter } from "../../http";
import { app } from "../../foundation/app";
import { LogManager } from "./LogManager";

export class LoggingRouter extends ApiRouter {
  middlewares = ["cache:private,0"];
  routes = {
    "/live": this.get(async () => {
      const file = Bun.file(app(LogManager).currentLogFilePath);
      return new Response(await file.text(), {
        headers: {
          "Content-Type": "text/plain",
        },
      });
    }),
  };
}
