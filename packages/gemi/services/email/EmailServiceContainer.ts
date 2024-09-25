import { ServiceContainer } from "../ServiceContainer";
import { EmailServiceProvider } from "./EmailServiceProvider";

export class EmailServiceContainer extends ServiceContainer {
  static _name = "EmailServiceContainer";

  constructor(public service: EmailServiceProvider) {
    super();
  }
}
