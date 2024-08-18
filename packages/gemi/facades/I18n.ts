import type { ViewRPC } from "../client/rpc";

export class I18n {
  static scope<T extends keyof ViewRPC>(scope: T) {
    return scope;
  }
}
