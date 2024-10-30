import { ApiRouter } from "../../http";
import { LoggingServiceContainer } from "./LoggingServiceContainer";

export class LoggingRouter extends ApiRouter {
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
