import { ServiceContainer } from "../ServiceContainer";
import { EmailServiceProvider } from "./EmailServiceProvider";

export class EmailServiceContainer extends ServiceContainer {
  static name = "emailServiceContainer";
  constructor(public service: EmailServiceProvider) {
    super();
  }
}
