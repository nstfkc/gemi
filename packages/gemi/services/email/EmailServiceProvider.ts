import { ServiceProvider } from "../ServiceProvider";
import { EmailDriver } from "./drivers/EmailDriver";
import { ResendDriver } from "./drivers/ResendDriver";

export class EmailServiceProvider extends ServiceProvider {
  debug = process.env.NODE_ENV === "development";
  defaultFrom = "";
  driver: EmailDriver = new ResendDriver();

  boot() {}
}
