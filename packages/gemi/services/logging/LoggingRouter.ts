import { ApiRouter } from "../../http";
import { LoggingServiceContainer } from "./LoggingServiceContainer";

export class LoggingRouter extends ApiRouter {
  middlewares = ["cache:private,0"];
  routes = {
    "/live": this.get(async () => {
      const file = Bun.file(LoggingServiceContainer.use().currentLogFilePath);
      return new Response(await file.text(), {
        headers: {
          "Content-Type": "text/plain",
        },
      });
    }),
  };
}
