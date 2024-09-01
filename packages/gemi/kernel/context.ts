import { AsyncLocalStorage } from "async_hooks";
import { EmailServiceProvider } from "../email/EmailServiceProvider";
import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { PoliciesServiceProvider } from "../http/PoliciesServiceProvider";
import { I18nServiceContainer } from "../http/I18nServiceContainer";
import { FileStorageServiceContainer } from "../services/file-storage/FileStorageServiceContainer";
import { ApiRouterServiceContainer } from "../services/router/ApiRouterServiceContainer";
import { MiddlewareServiceContainer } from "../services/middleware/MiddlewareServiceContainer";
import { RateLimiterServiceContainer } from "../services/rate-limiter/RateLimiterServiceContainer";

export interface KernelContextValue {
  emailServiceProvider: EmailServiceProvider;
  authenticationServiceProvider: AuthenticationServiceProvider;
  policiesServiceProvider: PoliciesServiceProvider;
  i18nServiceContainer: I18nServiceContainer;
  fileStorageServiceContainer: FileStorageServiceContainer;
  apiRouterServiceContainer: ApiRouterServiceContainer;
  middlewareServiceContainer: MiddlewareServiceContainer;
  rateLimiterServiceContainer: RateLimiterServiceContainer;
}

export const kernelContext = new AsyncLocalStorage<KernelContextValue>();
