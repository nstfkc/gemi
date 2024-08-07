import { AsyncLocalStorage } from "async_hooks";
import { EmailServiceProvider } from "../email/EmailServiceProvider";
import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { PoliciesServiceProvider } from "../http/PoliciesServiceProvider";

export interface KernelContextValue {
  emailServiceProvider: EmailServiceProvider;
  authenticationServiceProvider?: AuthenticationServiceProvider;
  policiesServiceProvider?: PoliciesServiceProvider;
}

export const kernelContext = new AsyncLocalStorage<KernelContextValue>();
