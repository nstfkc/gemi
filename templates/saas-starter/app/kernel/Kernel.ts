import { Kernel } from "gemi/kernel";
import EmailServiceProvider from "../service-providers/EmailServiceProvider";
import AuthenticationServiceProvider from "../service-providers/AuthenticationServiceProvider";
import MiddlewareServiceProvider from "../service-providers/MiddlewareServiceProvider";
import PoliciesServiceProvider from "../service-providers/PoliciesServiceProvider";
import I18nServiceProvider from "../service-providers/I18nServiceProvider";
import FileStorageServiceProvider from "../service-providers/FileStorageServiceProvider";

export default class extends Kernel {
  emailServiceProvider = EmailServiceProvider;
  authenticationServiceProvider = AuthenticationServiceProvider;
  middlewareServiceProvider = MiddlewareServiceProvider;
  policiesServiceProvider = PoliciesServiceProvider;
  i18nServiceProvider = I18nServiceProvider;
  fileStorageServiceProvider = FileStorageServiceProvider;
}
