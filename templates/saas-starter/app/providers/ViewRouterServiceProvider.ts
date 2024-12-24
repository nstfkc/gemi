import { ViewRouterServiceProvider } from "gemi/services";
import { createRoot } from "gemi/client";

import RootViewRouter from "../http/router/view";
import RootLayout from "../views/RootLayout";
import type { HttpRequest } from "gemi/http";

export default class extends ViewRouterServiceProvider {
  rootRouter = RootViewRouter;
  root = createRoot(RootLayout);

  onRequestStart(req: HttpRequest) {
    // console.log(`View start ${req.rawRequest.url}`);
  }

  onRequestEnd(req: HttpRequest) {
    // console.log(`View end ${req.rawRequest.url}`);
  }

  onRequestFail(req: HttpRequest, err: any) {
    console.log(`View fail ${req.rawRequest.url}`, err);
  }
}
