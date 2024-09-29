import { ServiceProvider } from "../ServiceProvider";
import { EmailDriver } from "./drivers/EmailDriver";
import { ResendDriver } from "./drivers/ResendDriver";

export class EmailServiceProvider extends ServiceProvider {
  driver: EmailDriver = new ResendDriver();

  boot() {}
}
