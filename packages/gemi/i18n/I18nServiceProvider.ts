import type { Dictionary } from "./Dictionary";
import { ServiceProvider } from "../services/ServiceProvider";

export class I18nServiceProvider extends ServiceProvider {
  boot() {}
  supportedLocales: string[] = [];
  defaultLocale = "en-US";
  prefetch: Record<string, Array<Dictionary<any>>> = {};
  components: Record<string, Dictionary<any>> = {};
  detectLocale(_req: any) {
    return "en-US";
  }
}
