import type { ViewRPC, I18nDictionary } from "../client/rpc";
import { I18nServiceContainer } from "../http/I18nServiceContainer";
import { RequestContext } from "../http/requestContext";
import { KernelContext } from "../kernel/KernelContext";
import { applyTranslationParams } from "../utils/applyTranslationParams";
import type { IsEmptyObject, ParseTranslationParams } from "../utils/type";

export class I18n {
  static scope<T extends keyof ViewRPC | "global" | "server">(scope: T): T {
    return scope;
  }
  static translate<
    // @ts-ignore
    T extends keyof I18nDictionary["server"],
    // @ts-ignore
    U = ParseTranslationParams<I18nDictionary["server"][T]["default"]>,
  >(key: T, ...args: IsEmptyObject<U> extends true ? [] : [params: U]) {
    const container = I18nServiceContainer.use();
    const locale = container.detectLocale(RequestContext.getStore().req);

    const translation = container.translations.get(`${locale}.server`)?.[key];

    if (!translation) {
      return key as any;
    }

    return applyTranslationParams(translation, args[0] as any);
  }
}
