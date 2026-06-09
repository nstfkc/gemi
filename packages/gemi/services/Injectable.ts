import { CustomServiceContainer } from "./custom-service/CustomServiceContainer";

export class Injectable {
  // @internal
  static instance = null;

  static inject<T extends Injectable>(this: new () => T): T {
    if (process.env.NODE_ENV === 'test') {
      return undefined;
    }
    if (Injectable.instance === null) {
      Injectable.instance = new this();
    }

    const customServiceProvider = CustomServiceContainer.use().service
    if(customServiceProvider.services.has(this.name)){
      return customServiceProvider.services.get(this.name) as T
    }
    const instance = new this();
    customServiceProvider.services.set(this.name, instance)
    return instance;
  }
}

export class Service extends Injectable {}
