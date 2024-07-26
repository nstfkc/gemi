import { AsyncLocalStorage } from "async_hooks";
import { EmailServiceProvider } from "../email/EmailServiceProvider";
import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";

export interface KernelContextValue {
  emailServiceProvider: EmailServiceProvider;
  authenticationServiceProvider?: AuthenticationServiceProvider;
}

export const kernelContext = new AsyncLocalStorage<KernelContextValue>();
