import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { kernelContext } from "./context";
import { MiddlewareServiceProvider } from "../http/MiddlewareServiceProvider";
import { PoliciesServiceProvider } from "../http/PoliciesServiceProvider";
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

export class Kernel {
  protected emailServiceProvider = EmailServiceProvider;
  protected authenticationServiceProvider = AuthenticationServiceProvider;
  protected middlewareServiceProvider = MiddlewareServiceProvider;
  protected policiesServiceProvider = PoliciesServiceProvider;
  protected i18nServiceProvider = I18nServiceProvider;
  protected fileStorageServiceProvider = FileStorageServiceProvider;
  protected apiRouterServiceProvider = ApiRouterServiceProvider;
  protected rateLimiterServiceProvider = RateLimiterServiceProvider;

  services: {
    emailServiceContainer: EmailServiceContainer;
    authenticationServiceProvider: AuthenticationServiceProvider;
    policiesServiceProvider: PoliciesServiceProvider;
    i18nServiceContainer: I18nServiceContainer;
    fileStorageServiceContainer: FileStorageServiceContainer;
    apiRouterServiceContainer: ApiRouterServiceContainer;
    middlewareServiceContainer: MiddlewareServiceContainer;
    rateLimiterServiceContainer: RateLimiterServiceContainer;
  };

  getServices = () => {
    if (!this.services) {
      this.services = {
        emailServiceContainer: new EmailServiceContainer(
          new this.emailServiceProvider(),
        ),
        authenticationServiceProvider: new this.authenticationServiceProvider(),
        middlewareServiceContainer: new MiddlewareServiceContainer(
          new this.middlewareServiceProvider(),
        ),
        policiesServiceProvider: new this.policiesServiceProvider(),
        i18nServiceContainer: new I18nServiceContainer(
          new this.i18nServiceProvider(),
        ),
        fileStorageServiceContainer: new FileStorageServiceContainer(
          new this.fileStorageServiceProvider(),
        ),
        apiRouterServiceContainer: new ApiRouterServiceContainer(
          new this.apiRouterServiceProvider(),
        ),
        rateLimiterServiceContainer: new RateLimiterServiceContainer(
          new this.rateLimiterServiceProvider(),
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
