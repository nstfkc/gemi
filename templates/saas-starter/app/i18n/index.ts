import { Dictionary } from "gemi/i18n";

/**
 * The legacy dictionary API, kept here as a working example of what an app
 * still on it looks like. New dictionaries belong next to the component that
 * reads them — see `app/views/Home.i18n.ts`.
 *
 * The difference this directory exists to show: every dictionary below has to
 * be re-exported here *and* listed against a route in the `prefetch` map in
 * `app/config/translation.ts`, and all of it is held in memory for every locale
 * whether a page uses it or not.
 */
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

export default { About };
