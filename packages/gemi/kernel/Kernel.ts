import { EmailServiceProvider } from "../email/EmailServiceProvider";
import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { kernelContext } from "./context";
import { MiddlewareServiceProvider } from "../http/MiddlewareServiceProvider";
import { PoliciesServiceProvider } from "../http/PoliciesServiceProvider";
import { I18nServiceProvider } from "../http/I18nServiceProvider";
import { I18nServiceContainer } from "../http/I18nServiceContainer";

export class Kernel {
  protected emailServiceProvider = EmailServiceProvider;
  protected authenticationServiceProvider = AuthenticationServiceProvider;
  protected middlewareServiceProvider = MiddlewareServiceProvider;
  protected policiesServiceProvider = PoliciesServiceProvider;
  protected i18nServiceProvider = I18nServiceProvider;

  services: {
    emailServiceProvider: EmailServiceProvider;
    authenticationServiceProvider: AuthenticationServiceProvider;
    middlewareServiceProvider: MiddlewareServiceProvider;
    policiesServiceProvider: PoliciesServiceProvider;
    i18nServiceContainer: I18nServiceContainer;
  };

  getServices = () => {
    if (!this.services) {
      this.services = {
        emailServiceProvider: new this.emailServiceProvider(),
        authenticationServiceProvider: new this.authenticationServiceProvider(),
        middlewareServiceProvider: new this.middlewareServiceProvider(),
        policiesServiceProvider: new this.policiesServiceProvider(),
        i18nServiceContainer: new I18nServiceContainer(
          new this.i18nServiceProvider(),
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
