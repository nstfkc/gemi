import { KernelContext } from "../kernel/KernelContext";
import { ServiceProvider } from "./ServiceProvider";

export class ServiceContainer {
  static name: string;
  service: ServiceProvider;

  static use<T extends ServiceContainer>(
    this: new (service: ServiceProvider) => T,
  ): T["service"] {
    return KernelContext.getStore()[this.name].service;
  }
}
