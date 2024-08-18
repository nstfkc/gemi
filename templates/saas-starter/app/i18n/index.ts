import { I18n } from "gemi/facades";

const home = {
  hi: {
    "en-US": "Hello {name}",
    "es-ES": "Hola {name}",
  },
  bye: {
    "en-US": "Goodbye",
    "es-ES": "Adios",
  },
} as const;

export const dictionary = {
  [I18n.scope("layout:/")]: {
    home: {
      "en-US": "Home",
      "es-ES": "Inicio",
    },
    about: {
      "en-US": "About",
      "es-ES": "Acerca de",
    },
  },
  [I18n.scope("view:/")]: home,
} as const;

export type Dictionary = typeof dictionary;
