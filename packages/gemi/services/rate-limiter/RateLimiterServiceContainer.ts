import { ServiceContainer } from "../ServiceContainer";
import { RateLimiterServiceProvider } from "./RateLimiterServiceProvider";

export class RateLimiterServiceContainer extends ServiceContainer {
  name = "RateLimiterServiceContainer";

  constructor(public service: RateLimiterServiceProvider) {
    super();
  }
}
