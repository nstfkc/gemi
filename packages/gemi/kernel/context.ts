import { AsyncLocalStorage } from "async_hooks";
import { EmailServiceProvider } from "../email/EmailServiceProvider";
import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { PoliciesServiceProvider } from "../http/PoliciesServiceProvider";
import { MiddlewareServiceProvider } from "../http";
import { I18nServiceContainer } from "../http/I18nServiceContainer";
import { FileStorageServiceContainer } from "../services/file-storage/FileStorageServiceContainer";

export interface KernelContextValue {
  emailServiceProvider: EmailServiceProvider;
  authenticationServiceProvider: AuthenticationServiceProvider;
  middlewareServiceProvider: MiddlewareServiceProvider;
  policiesServiceProvider: PoliciesServiceProvider;
  i18nServiceContainer: I18nServiceContainer;
  fileStorageServiceContainer: FileStorageServiceContainer;
}

export const kernelContext = new AsyncLocalStorage<KernelContextValue>();
