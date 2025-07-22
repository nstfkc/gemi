import { kernelContext } from "./context";
import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { AuthenticationServiceContainer } from "../auth/AuthenticationServiceContainer";
import { MiddlewareServiceProvider } from "../http/MiddlewareServiceProvider";
import { I18nServiceProvider } from "../i18n/I18nServiceProvider";
import { I18nServiceContainer } from "../i18n/I18nServiceContainer";
import { FileStorageServiceContainer } from "../services/file-storage/FileStorageServiceContainer";
import { FileStorageServiceProvider } from "../services/file-storage/FileStorageServiceProvider";
import { ApiRouterServiceContainer } from "../services/router/ApiRouterServiceContainer";
import { ApiRouterServiceProvider } from "../services/router/ApiRouterServiceProvider";
import { MiddlewareServiceContainer } from "../services/middleware/MiddlewareServiceContainer";
import { RateLimiterServiceContainer } from "../services/rate-limiter/RateLimiterServiceContainer";
import { QueueServiceProvider, RateLimiterServiceProvider } from "../services";
import { EmailServiceProvider } from "../services/email/EmailServiceProvider";
import { EmailServiceContainer } from "../services/email/EmailServiceContainer";
import { BroadcastingServiceContainer } from "../services/pubsub/BroadcastingServiceContainer";
import { BroadcastingServiceProvider } from "../services/pubsub/BroadcastingServiceProvider";
import { ViewRouterServiceContainer } from "../services/router/ViewRouterServiceContainer";
import { ViewRouterServiceProvider } from "../services/router/ViewRouterServiceProvider";
import type { ServiceContainer } from "../services/ServiceContainer";
import { LoggingServiceContainer } from "../services/logging/LoggingServiceContainer";
import { LoggingServiceProvider } from "../services/logging/LoggingServiceProvider";
import { QueueServiceContainer } from "../services/queue/QueueServiceContainer";
import { ImageOptimizationServiceProvider } from "../services/image-optimization/ImageOptimizationServiceProvider";
import { ImageOptimizationServiceContainer } from "../services/image-optimization/ImageOptimizationServiceContainer";
import { CronServiceProvider } from "../services/cron/CronServiceProvider";
import { CronServiceContainer } from "../services/cron/CronServiceContainer";

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
  protected queueServiceProvider = QueueServiceProvider;
  protected imageServiceProvider = ImageOptimizationServiceProvider;
  protected cronServiceProvider = CronServiceProvider;

  services: Record<string, ServiceContainer> = {};
  private booted = false;

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
      [QueueServiceContainer._name]: new QueueServiceContainer(
        new this.queueServiceProvider(),
      ),
      [ImageOptimizationServiceContainer._name]:
        new ImageOptimizationServiceContainer(new this.imageServiceProvider()),
      [CronServiceContainer._name]: new CronServiceContainer(
        new this.cronServiceProvider(this),
      ),
    };
    this.booted = true;
  }

  run<T>(cb: () => T) {
    const services = this.services;
    return kernelContext.run(services, cb);
  }

  destroy() {
    for (const key of Object.keys(this.services)) {
      delete this.services[key];
    }

    kernelContext.disable();
  }

  async waitForBoot() {
    if (!this.booted) {
      await new Promise<void>((resolve) => {
        while (!this.booted) {
          setTimeout(() => {
            if (this.booted) {
              resolve();
            }
          }, 10);
        }
      });
    }
  }
}
