import { EmailServiceProvider } from "../email/EmailServiceProvider";
import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { kernelContext } from "./context";

export class Kernel {
  protected emailServiceProvider = EmailServiceProvider;
  protected authenticationServiceProvider = AuthenticationServiceProvider;

  services: {
    emailServiceProvider: EmailServiceProvider;
    authenticationServiceProvider: AuthenticationServiceProvider;
  };

  getServices = () => {
    if (!this.services) {
      this.services = {
        emailServiceProvider: new this.emailServiceProvider(),
        authenticationServiceProvider: new this.authenticationServiceProvider(),
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
