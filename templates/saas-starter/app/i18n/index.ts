import { Dictionary } from "gemi/i18n/i18n/index.ts";

const HomePage = Dictionary.create("HomePage", {
  title: {
    "en-US": "Welcome to Gemi {{version}}",
    "tr-TR": "Gemi'ye Hoş Geldiniz {{version}}",
  },
  description: {
    "en-US": "A simple and fast framework for building web applications.",
    "tr-TR": "Web uygulamaları oluşturmak için basit ve hızlı bir çerçeve.",
  },
});

const About = Dictionary.create("About", {
  title: {
    "en-US": "About",
    "tr-TR": "Hakkında",
  },
});

export default { HomePage, About };
