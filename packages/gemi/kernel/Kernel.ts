import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { AuthenticationServiceContianer } from "../auth/AuthenticationServiceContainer";
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

  services: {
    emailServiceContainer: EmailServiceContainer;
    authenticationServiceContainer: AuthenticationServiceContianer;
    i18nServiceContainer: I18nServiceContainer;
    fileStorageServiceContainer: FileStorageServiceContainer;
    apiRouterServiceContainer: ApiRouterServiceContainer;
    viewRouterServiceContainer: ViewRouterServiceContainer;
    middlewareServiceContainer: MiddlewareServiceContainer;
    rateLimiterServiceContainer: RateLimiterServiceContainer;
    broadcastingServiceContainer: BroadcastingServiceContainer;
  };

  getServices = () => {
    if (!this.services) {
      this.services = {
        emailServiceContainer: new EmailServiceContainer(
          new this.emailServiceProvider(),
        ),
        authenticationServiceContainer: new AuthenticationServiceContianer(
          new this.authenticationServiceProvider(),
        ),
        middlewareServiceContainer: new MiddlewareServiceContainer(
          new this.middlewareServiceProvider(),
        ),
        i18nServiceContainer: new I18nServiceContainer(
          new this.i18nServiceProvider(),
        ),
        fileStorageServiceContainer: new FileStorageServiceContainer(
          new this.fileStorageServiceProvider(),
        ),
        apiRouterServiceContainer: new ApiRouterServiceContainer(
          new this.apiRouterServiceProvider(),
        ),
        viewRouterServiceContainer: new ViewRouterServiceContainer(
          new this.viewRouterServiceProvider(),
        ),
        rateLimiterServiceContainer: new RateLimiterServiceContainer(
          new this.rateLimiterServiceProvider(),
        ),
        broadcastingServiceContainer: new BroadcastingServiceContainer(
          new this.broadcastingsServiceProvider(),
        ),
      };
    }
    return this.services;
  };

  static getContext = () => kernelContext.getStore();

  run<T>(cb: () => T) {
    const services = this.getServices();
    return kernelContext.run(services, cb);
  }
}
