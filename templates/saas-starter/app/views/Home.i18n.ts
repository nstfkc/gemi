import { defineDictionary } from "gemi/client";

/**
 * The strings this view renders, next to the view that renders them.
 *
 * Every locale is written here, but gemi's Vite plugin splits them into one
 * chunk per locale, so a visitor downloads only the one they are reading in.
 * There is nothing to register in `app/i18n/index.ts` and nothing to add to the
 * `prefetch` map in `app/config/translation.ts`.
 *
 * The first locale is the source language: a key missing from another locale
 * falls back to it.
 */
export const homeDict = defineDictionary({
  title: {
    "en-US": "Welcome to Gemi {{version}}",
    "tr-TR": "Gemi'ye Hoş Geldiniz {{version}}",
  },
  description: {
    "en-US": "A simple and fast framework for building web applications.",
    "tr-TR": "Web uygulamaları oluşturmak için basit ve hızlı bir çerçeve.",
  },
});
