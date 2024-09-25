import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { AuthenticationServiceContainer } from "../auth/AuthenticationServiceContainer";
import { kernelContext } from "./context";
import { MiddlewareServiceProvider } from "../http/MiddlewareServiceProvider";
import { I18nServiceProvider } from "../http/I18nServiceProvider";
import { I18nServiceContainer } from "../http/I18nServiceContainer";
import { FileStorageServiceContainer } from "../services/file-storage/FileStorageServiceContainer";
import { FileStorageServiceProvider } from "../services/file-storage/FileStorageServiceProvider";
import { ApiRouterServiceContainer } from "../services/router/ApiRouterServiceContainer";
import { ApiRouterServiceProvider } from "../services/router/ApiRouterServiceProvider";
import { MiddlewareServiceContainer } from "../services/middleware/MiddlewareServiceContainer";
import { RateLimiterServiceContainer } from "../services/rate-limiter/RateLimiterServiceContainer";
import { RateLimiterServiceProvider } from "../services";
import { EmailServiceProvider } from "../services/email/EmailServiceProvider";
import { EmailServiceContainer } from "../services/email/EmailServiceContainer";
import { BroadcastingServiceContainer } from "../services/pubsub/BroadcastingServiceContainer";
import { BroadcastingServiceProvider } from "../services/pubsub/BroadcastingServiceProvider";
import { ViewRouterServiceContainer } from "../services/router/ViewRouterServiceContainer";
import { ViewRouterServiceProvider } from "../services/router/ViewRouterServiceProvider";
import { ServiceContainer } from "../services/ServiceContainer";

export class Kernel {
  protected emailServiceProvider = EmailServiceProvider;
  protected authenticationServiceProvider = AuthenticationServiceProvider;
  protected middlewareServiceProvider = MiddlewareServiceProvider;
  protected i18nServiceProvider = I18nServiceProvider;
  protected fileStorageServiceProvider = FileStorageServiceProvider;
  protected apiRouterServiceProvider = ApiRouterServiceProvider;
  protected viewRouterServiceProvider = ViewRouterServiceProvider;
  protected rateLimiterServiceProvider = RateLimiterServiceProvider;
  protected broadcastingsServiceProvider = BroadcastingServiceProvider;

  services: Record<string, ServiceContainer> = {};

  boot() {
    this.registerServiceContainers(
      new EmailServiceContainer(new this.emailServiceProvider()),
      new AuthenticationServiceContainer(
        new this.authenticationServiceProvider(),
      ),
      new MiddlewareServiceContainer(new this.middlewareServiceProvider()),
      new I18nServiceContainer(new this.i18nServiceProvider()),
      new FileStorageServiceContainer(new this.fileStorageServiceProvider()),
      new ApiRouterServiceContainer(new this.apiRouterServiceProvider()),
      new ViewRouterServiceContainer(new this.viewRouterServiceProvider()),
      new RateLimiterServiceContainer(new this.rateLimiterServiceProvider()),
      new BroadcastingServiceContainer(new this.broadcastingsServiceProvider()),
    );
  }

  registerServiceContainers(...containers: ServiceContainer[]) {
    for (const container of containers) {
      this.services[container.name] = container;
    }
  }

  run<T>(cb: () => T) {
    return kernelContext.run(this.services, cb);
  }
}
