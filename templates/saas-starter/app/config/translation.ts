import { defineTranslationConfig } from "gemi/i18n";

import components from "@/app/i18n";

export default defineTranslationConfig({
  defaultLocale: "en-US",
  supportedLocales: ["en-US", "tr-TR"],
  prefetch: {
    "/": [components.HomePage],
    "/about": [components.About],
  },
  onLocaleChange(locale: string) {
    console.log(`Locale changed to ${locale}`);
  },
});
