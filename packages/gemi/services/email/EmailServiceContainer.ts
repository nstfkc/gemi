import { ServiceContainer } from "../ServiceContainer";
import { EmailServiceProvider } from "./EmailServiceProvider";

export class EmailServiceContainer extends ServiceContainer {
  public name = "EmailServiceContainer";

  constructor(public service: EmailServiceProvider) {
    super();
  }
}
