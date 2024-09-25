import { ServiceContainer } from "../ServiceContainer";
import { RateLimiterServiceProvider } from "./RateLimiterServiceProvider";

export class RateLimiterServiceContainer extends ServiceContainer {
  constructor(public service: RateLimiterServiceProvider) {
    super();
  }
}
