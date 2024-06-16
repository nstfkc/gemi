import { createServer } from "gemi/server";
import { app } from "./bootstrap";
import RootLayout from "./views/RootLayout";

export default createServer({
  app,
  RootLayout,
});
