import { Dictionary } from "gemi/i18n";

const HomePage = Dictionary.create("HomePage", {
  title: {
    "en-US": "Welcome to Gemi {{version}}",
    es: "Bienvenido a Gemi {{version}}",
    de: "Willkommen bei Gemi {{version}}",
    tr: "Gemi'ye Hoş Geldiniz {{version}}",
  },
  description: {
    "en-US": "A simple and fast framework for building web applications.",
    es: "Un marco simple y rápido para construir aplicaciones web.",
    de: "Ein einfaches und schnelles Framework zum Erstellen von Webanwendungen.",
    tr: "Web uygulamaları oluşturmak için basit ve hızlı bir çerçeve.",
  },
});

const About = Dictionary.create("About", {
  title: {
    "en-US": "About",
    es: "Aboute",
    de: "asdasd",
    tr: "Hello world",
  },
});

export default { HomePage, About };
