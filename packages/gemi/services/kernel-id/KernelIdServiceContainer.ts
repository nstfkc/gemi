import { ServiceContainer } from "../ServiceContainer";
import { KernelIdServiceProvider } from "./KernelIdServiceProvider";

export class KernelIdServiceContainer extends ServiceContainer {
  static _name = "KernelIdServiceContainer";
  constructor(public service: KernelIdServiceProvider) {
    super();
  }
}
