import type { Dictionary } from "./Dictionary";
import { ServiceProvider } from "../services/ServiceProvider";
import type { HttpRequest } from "../http/HttpRequest";

export class I18nServiceProvider extends ServiceProvider {
  boot() {}
  supportedLocales: string[] = [];
  defaultLocale = "en-US";
  prefetch: Record<string, Array<Dictionary<any>>> = {};
  components: Record<string, Dictionary<any>> = {};
  detectLocale(_req: HttpRequest): string | null {
    return null;
  }
}
