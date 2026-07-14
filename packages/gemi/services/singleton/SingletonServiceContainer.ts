import { ServiceContainer  } from "../ServiceContainer"
import { SingletonServiceProvider } from "./SingletonServiceProvider";

export class SingletonServiceContainer extends ServiceContainer {
  static _name = "SingletonServiceContainer";

  constructor(public service: SingletonServiceProvider) {
    super();
  }
}
