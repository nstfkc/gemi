import { kernelContext } from "../kernel/context";
import { ServiceProvider } from "./ServiceProvider";

export class ServiceContainer {
  public name: string;
  service: ServiceProvider;

  static use<T extends ServiceContainer>(
    this: new (service: ServiceProvider) => T,
  ): T {
    const store = kernelContext.getStore();
    if (!store[this.name]) {
      console.log("Container is not registered", this.name);
      console.log("Available containers", Object.keys(store));
    }
    return store[this.name];
  }
}
