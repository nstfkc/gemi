import { ServiceContainer } from "../ServiceContainer";
import { RateLimiterServiceProvider } from "./RateLimiterServiceProvider";

export class RateLimiterServiceContainer extends ServiceContainer {
  static _name = "RateLimiterServiceContainer";

  constructor(public service: RateLimiterServiceProvider) {
    super();
  }
}
