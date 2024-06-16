import { type App } from "../app/App";
import { createDevServer } from "./createDevServer";

interface Params {
  app: App;
  RootLayout: () => JSX.Element;
}

export async function createServer(params: Params) {
  if (process.env.NODE_ENV === "development") {
    await createDevServer(params);
  }
}
