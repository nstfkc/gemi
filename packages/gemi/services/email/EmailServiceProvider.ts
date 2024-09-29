import { ServiceProvider } from "../ServiceProvider";
import { EmailDriver } from "./drivers/EmailDriver";
import { ResendDriver } from "./drivers/ResendDriver";

export class EmailServiceProvider extends ServiceProvider {
  debug = process.env.NODE_ENV === "development";
  defaultFrom = "No Reply <noreply@email.com>";
  driver: EmailDriver = new ResendDriver();

  boot() {}
}
