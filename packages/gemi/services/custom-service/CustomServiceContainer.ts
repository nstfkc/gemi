import { ServiceContainer  } from "../ServiceContainer"
import { CustomServiceProvider } from "./CustomServiceProvider";

export class CustomServiceContainer extends ServiceContainer {
  static _name = "CustomServiceContainer";

  constructor(public service: CustomServiceProvider) {
    super();
  }
}
