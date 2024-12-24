import { kernelContext } from "../kernel/context";
import { ServiceProvider } from "./ServiceProvider";

export class ServiceContainer {
  static _name: string;
  service: ServiceProvider;

  static use<T extends ServiceContainer>(
    this: new (service: ServiceProvider) => T,
  ): T {
    const store = kernelContext.getStore();
    if (!store) {
      // console.error("Kernel is not available");
      return;
    }
    // @ts-ignore
    if (!store?.[this._name]) {
      // @ts-ignore
      console.log("Container is not registered", this._name);
      console.log("Available containers", Object.keys(store));
    }

    // @ts-ignore
    return store[this._name];
  }
}
