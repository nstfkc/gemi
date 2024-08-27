import { EmailServiceProvider } from "../email/EmailServiceProvider";
import { AuthenticationServiceProvider } from "../auth/AuthenticationServiceProvider";
import { kernelContext } from "./context";
import { MiddlewareServiceProvider } from "../http/MiddlewareServiceProvider";
import { PoliciesServiceProvider } from "../http/PoliciesServiceProvider";
import { I18nServiceProvider } from "../http/I18nServiceProvider";
import { I18nServiceContainer } from "../http/I18nServiceContainer";
import { FileStorageServiceContainer } from "../services/file-storage/FileStorageServiceContainer";
import { FileStorageServiceProvider } from "../services/file-storage/FileStorageServiceProvider";

export class Kernel {
  protected emailServiceProvider = EmailServiceProvider;
  protected authenticationServiceProvider = AuthenticationServiceProvider;
  protected middlewareServiceProvider = MiddlewareServiceProvider;
  protected policiesServiceProvider = PoliciesServiceProvider;
  protected i18nServiceProvider = I18nServiceProvider;
  protected fileStorageServiceProvider = FileStorageServiceProvider;

  services: {
    emailServiceProvider: EmailServiceProvider;
    authenticationServiceProvider: AuthenticationServiceProvider;
    middlewareServiceProvider: MiddlewareServiceProvider;
    policiesServiceProvider: PoliciesServiceProvider;
    i18nServiceContainer: I18nServiceContainer;
    fileStorageServiceContainer: FileStorageServiceContainer;
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
        fileStorageServiceContainer: new FileStorageServiceContainer(
          new this.fileStorageServiceProvider(),
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
