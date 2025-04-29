import { Dictionary } from "gemi/i18n";

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
    "en-US": "About {{version:[hi]}}",
    "tr-TR": "Hakkında {{version:[hi]}}",
  },
  para: {
    "en-US": "You are! {{break}} hello there",
    "tr-TR": "You are! {{break}} hello there",
  },
});

export default { HomePage, About };
