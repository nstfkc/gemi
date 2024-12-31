import { Kernel } from "gemi/kernel";

import AuthenticationServiceProvider from "./providers/AuthenticationServiceProvider";
import MiddlewareServiceProvider from "./providers/MiddlewareServiceProvider";
import I18nServiceProvider from "./providers/I18nServiceProvider";
import FileStorageServiceProvider from "./providers/FileStorageServiceProvider";
import ViewRouterServiceProvider from "./providers/ViewRouterServiceProvider";
import ApiRouterServiceProvider from "./providers/ApiRouterServiceProvider";
import LoggingServiceProvider from "./providers/LoggingServiceProvider";
import QueueServiceProvider from "./providers/QueueServiceProvider";
import EmailServiceProvider from "./providers/EmailServiceProvider";

export default class extends Kernel {
  authenticationServiceProvider = AuthenticationServiceProvider;
  apiRouterServiceProvider = ApiRouterServiceProvider;
  emailServiceProvider = EmailServiceProvider;
  fileStorageServiceProvider = FileStorageServiceProvider;
  i18nServiceProvider = I18nServiceProvider;
  middlewareServiceProvider = MiddlewareServiceProvider;
  loggingServiceProvider = LoggingServiceProvider;
  queueServiceProvider = QueueServiceProvider;
  viewRouterServiceProvider = ViewRouterServiceProvider;
}
