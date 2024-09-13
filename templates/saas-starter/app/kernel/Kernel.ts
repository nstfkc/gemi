import { Kernel } from "gemi/kernel";
import AuthenticationServiceProvider from "../service-providers/AuthenticationServiceProvider";
import MiddlewareServiceProvider from "../service-providers/MiddlewareServiceProvider";
import PoliciesServiceProvider from "../service-providers/PoliciesServiceProvider";
import I18nServiceProvider from "../service-providers/I18nServiceProvider";
import FileStorageServiceProvider from "../service-providers/FileStorageServiceProvider";
import BroadcastingServiceProvider from "../service-providers/BroadcastingServiceProvider";

export default class extends Kernel {
  authenticationServiceProvider = AuthenticationServiceProvider;
  middlewareServiceProvider = MiddlewareServiceProvider;
  policiesServiceProvider = PoliciesServiceProvider;
  i18nServiceProvider = I18nServiceProvider;
  fileStorageServiceProvider = FileStorageServiceProvider;
  broadcastingsServiceProvider = BroadcastingServiceProvider;
}
