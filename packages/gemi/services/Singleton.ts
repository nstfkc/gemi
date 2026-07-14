import { SingletonServiceContainer } from "./singleton/SingletonServiceContainer";

export class Singleton {
  static use<T extends Singleton>(this: new () => T): T {
    const customServiceProvider = SingletonServiceContainer.use().service;
    if (customServiceProvider.services.has(this.name)) {
      return customServiceProvider.services.get(this.name) as T;
    }

    const instance = new this();
    customServiceProvider.services.set(this.name, instance);
    return instance;
  }
}
