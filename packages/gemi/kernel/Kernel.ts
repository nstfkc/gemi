import { EmailServiceProvider } from "../email/EmailServiceProvider";
import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { kernelContext } from "./context";
import { MiddlewareServiceProvider } from "../http/MiddlewareServiceProvider";

export class Kernel {
  protected emailServiceProvider = EmailServiceProvider;
  protected authenticationServiceProvider = AuthenticationServiceProvider;
  protected middlewareServiceProvider = MiddlewareServiceProvider;

  services: {
    emailServiceProvider: EmailServiceProvider;
    authenticationServiceProvider: AuthenticationServiceProvider;
    middlewareServiceProvider: MiddlewareServiceProvider;
  };

  getServices = () => {
    if (!this.services) {
      this.services = {
        emailServiceProvider: new this.emailServiceProvider(),
        authenticationServiceProvider: new this.authenticationServiceProvider(),
        middlewareServiceProvider: new this.middlewareServiceProvider(),
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
