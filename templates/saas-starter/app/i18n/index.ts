import { I18n } from "gemi/facades";

export type Dictionary = typeof dictionary;

export const dictionary = {
  [I18n.scope("layout:/")]: {
    home: {
      default: "Home",
      es: "Inicio",
    },
    about: {
      default: "About",
      es: "Acerca de",
    },
    greeting: {
      default: "Hello, {{name}}",
      es: "Hola, {{name}}",
    },
  },
  [I18n.scope("view:/")]: {
    hi: {
      default: "Hello {{name}}",
      es: "Hola {{name}}",
    },
    bye: {
      default: "Goodbye",
      es: "Adios",
    },
  },
} as const;
