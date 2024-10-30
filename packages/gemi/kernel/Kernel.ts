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
import { LoggingServiceContainer } from "../services/logging/LoggingServiceContainer";
import { LoggingServiceProvider } from "../services/logging/LoggingServiceProvider";

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
  protected loggingServiceProvider = LoggingServiceProvider;

  services: Record<string, ServiceContainer> = {};

  boot() {
    this.services = {
      [EmailServiceContainer._name]: new EmailServiceContainer(
        new this.emailServiceProvider(),
      ),
      [AuthenticationServiceContainer._name]:
        new AuthenticationServiceContainer(
          new this.authenticationServiceProvider(),
        ),
      [MiddlewareServiceContainer._name]: new MiddlewareServiceContainer(
        new this.middlewareServiceProvider(),
      ),
      [I18nServiceContainer._name]: new I18nServiceContainer(
        new this.i18nServiceProvider(),
      ),
      [FileStorageServiceContainer._name]: new FileStorageServiceContainer(
        new this.fileStorageServiceProvider(),
      ),
      [ApiRouterServiceContainer._name]: new ApiRouterServiceContainer(
        new this.apiRouterServiceProvider(),
      ),
      [ViewRouterServiceContainer._name]: new ViewRouterServiceContainer(
        new this.viewRouterServiceProvider(),
      ),
      [RateLimiterServiceContainer._name]: new RateLimiterServiceContainer(
        new this.rateLimiterServiceProvider(),
      ),
      [BroadcastingServiceContainer._name]: new BroadcastingServiceContainer(
        new this.broadcastingsServiceProvider(),
      ),
      [LoggingServiceContainer._name]: new LoggingServiceContainer(
        new this.loggingServiceProvider(),
      ),
    };
  }

  run<T>(cb: () => T) {
    const services = this.services;
    return kernelContext.run(services, cb);
  }
}
