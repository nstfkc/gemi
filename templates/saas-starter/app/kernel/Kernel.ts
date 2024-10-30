import { Kernel } from "gemi/kernel";

import AuthenticationServiceProvider from "../providers/AuthenticationServiceProvider";
import MiddlewareServiceProvider from "../providers/MiddlewareServiceProvider";
import PoliciesServiceProvider from "../providers/PoliciesServiceProvider";
import I18nServiceProvider from "../providers/I18nServiceProvider";
import FileStorageServiceProvider from "../providers/FileStorageServiceProvider";
import BroadcastingServiceProvider from "../providers/BroadcastingServiceProvider";
import ViewRouterServiceProvider from "../providers/ViewRouterServiceProvider";
import ApiRouterServiceProvider from "../providers/ApiRouterServiceProvider";
import LoggingServiceProvider from "../providers/LoggingServiceProvider";

export default class extends Kernel {
  authenticationServiceProvider = AuthenticationServiceProvider;
  middlewareServiceProvider = MiddlewareServiceProvider;
  policiesServiceProvider = PoliciesServiceProvider;
  i18nServiceProvider = I18nServiceProvider;
  fileStorageServiceProvider = FileStorageServiceProvider;
  broadcastingsServiceProvider = BroadcastingServiceProvider;
  viewRouterServiceProvider = ViewRouterServiceProvider;
  apiRouterServiceProvider = ApiRouterServiceProvider;
  loggingServiceProvider = LoggingServiceProvider;
}
