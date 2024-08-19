import { I18n } from "gemi/facades";

export type Dictionary = typeof dictionary;

export const dictionary = {
  [I18n.scope("server")]: {
    "validation.fileTooLarge": {
      default: "File must be less than {{maxSize}} {{unit}}",
    },
  },
  [I18n.scope("global")]: {
    test: {
      default: "Test {{name}}",
    },
  },
  [I18n.scope("layout:/")]: {
    home: {
      default: "Home",
      "es-ES": "Inicio",
    },
    about: {
      default: "About",
      "es-ES": "Acerca de",
    },
  },
  [I18n.scope("view:/")]: {
    hi: {
      default: "Hello {{name}}",
      "es-ES": "Hola {{name}}",
    },
    bye: {
      default: "Goodbye",
      "es-ES": "Adios",
    },
  },
} as const;
