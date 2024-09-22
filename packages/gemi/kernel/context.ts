import { AsyncLocalStorage } from "async_hooks";
import { AuthenticationServiceContianer } from "../auth/AuthenticationServiceContainer";
import { PoliciesServiceProvider } from "../http/PoliciesServiceProvider";
import { I18nServiceContainer } from "../http/I18nServiceContainer";
import { FileStorageServiceContainer } from "../services/file-storage/FileStorageServiceContainer";
import { ApiRouterServiceContainer } from "../services/router/ApiRouterServiceContainer";
import { MiddlewareServiceContainer } from "../services/middleware/MiddlewareServiceContainer";
import { RateLimiterServiceContainer } from "../services/rate-limiter/RateLimiterServiceContainer";
import { EmailServiceContainer } from "../services/email/EmailServiceContainer";
import { BroadcastingServiceContainer } from "../services/pubsub/BroadcastingServiceContainer";

export interface KernelContextValue {
  emailServiceContainer: EmailServiceContainer;
  authenticationServiceContainer: AuthenticationServiceContianer;
  policiesServiceProvider: PoliciesServiceProvider;
  i18nServiceContainer: I18nServiceContainer;
  fileStorageServiceContainer: FileStorageServiceContainer;
  apiRouterServiceContainer: ApiRouterServiceContainer;
  middlewareServiceContainer: MiddlewareServiceContainer;
  rateLimiterServiceContainer: RateLimiterServiceContainer;
  broadcastingServiceContainer: BroadcastingServiceContainer;
}

export const kernelContext = new AsyncLocalStorage<KernelContextValue>();
