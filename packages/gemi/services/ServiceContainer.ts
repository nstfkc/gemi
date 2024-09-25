import { kernelContext } from "../kernel/context";
import { ServiceProvider } from "./ServiceProvider";

export class ServiceContainer {
  public name: string;
  service: ServiceProvider;

  static use<T extends ServiceContainer>(
    this: new (service: ServiceProvider) => T,
  ): T {
    return kernelContext.getStore()[this.name];
  }
}
