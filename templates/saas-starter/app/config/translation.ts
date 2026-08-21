import { defineTranslationConfig } from "gemi/i18n";

import components from "@/app/i18n";

export default defineTranslationConfig({
  defaultLocale: "en-US",
  supportedLocales: ["en-US", "tr-TR"],
  // Only for dictionaries built with the legacy `Dictionary.create`. A
  // `defineDictionary` dictionary needs no entry here — `/` is absent because
  // `Home.tsx` reads `app/views/Home.i18n.ts` directly.
  prefetch: {
    "/about": [components.About],
  },
  onLocaleChange(locale: string) {
    console.log(`Locale changed to ${locale}`);
  },
});
