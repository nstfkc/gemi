import { useState } from "react";
import { vi } from "vitest";
import { useDictionary } from "../../../../client/useDictionary";
import { useFormatter } from "../../../../client/useFormatter";
import { __gemi_dict__, defineDictionary } from "../../../../i18n/defineDictionary";

/**
 * Islands for the island-dictionary tests (#1095): one reads a dictionary
 * with a param only the browser knows, one only formats, one reads no i18n.
 */

export const strings = {
  "en-US": { rate: "VAT ({{rate}}%)", title: "Cart", applied: "{{code}} applied" },
  "tr-TR": { rate: "KDV (%{{rate}})", title: "Sepet", applied: "{{code}} uygulandı" },
  "de-DE": { rate: "MwSt. ({{rate}} %)", title: "Warenkorb", applied: "{{code}} eingelöst" },
} as const;

/**
 * Each locale's chunk load, as gemi's Vite plugin builds a dictionary, so a
 * load the browser makes is one a test can count.
 */
export const loads = vi.fn((locale: keyof typeof strings) =>
  Promise.resolve({ default: strings[locale] }),
);

export const cartDict = __gemi_dict__<{
  rate: { "en-US": "VAT ({{rate}}%)"; "tr-TR": "KDV (%{{rate}})"; "de-DE": "MwSt. ({{rate}} %)" };
  title: { "en-US": "Cart"; "tr-TR": "Sepet"; "de-DE": "Warenkorb" };
  applied: { "en-US": "{{code}} applied"; "tr-TR": "{{code}} uygulandı"; "de-DE": "{{code}} eingelöst" };
}>("island-dictionary-test", {
  "en-US": () => loads("en-US"),
  "tr-TR": () => loads("tr-TR"),
  "de-DE": () => loads("de-DE"),
});

/** A VAT line for a rate the browser reads (from the cart in storage, say). */
export default function VatLine(props: { rate: number }) {
  const t = useDictionary(cartDict);
  const [rate, setRate] = useState(props.rate);
  return (
    <div className="vat">
      <output>{t("rate", { rate })}</output>
      <button type="button" onClick={() => setRate(rate + 1)}>
        +1
      </button>
    </div>
  );
}

export function PlainCounter(props: { start: number }) {
  const [n, setN] = useState(props.start);
  return (
    <button type="button" className="plain" onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}

export function Amount() {
  const format = useFormatter();
  return <data>{format.number(1234.5)}</data>;
}

/**
 * A coupon line that reads the dictionary only once the buyer applies a code:
 * the server render reads no i18n at all.
 */
export function Coupon() {
  const [code, setCode] = useState<string | null>(null);
  return (
    <div className="coupon">
      <button type="button" className="apply" onClick={() => setCode("SAVE10")}>
        apply
      </button>
      {code && <Applied code={code} />}
    </div>
  );
}

function Applied(props: { code: string }) {
  const t = useDictionary(cartDict);
  return <p className="applied">{t("applied", { code: props.code })}</p>;
}

/** Strings that would end a script block or a comment if left unescaped. */
export const hostileDict = defineDictionary({
  note: {
    "en-US": "a</script><script>alert(1)</script><!--b\u2028c\u2029d",
    "tr-TR": "t</script><!--r\u2028",
  },
});

export function Hostile() {
  const t = useDictionary(hostileDict);
  return <q>{t("note")}</q>;
}
