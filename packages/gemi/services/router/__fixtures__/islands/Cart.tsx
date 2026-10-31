import { useState } from "react";
import { vi } from "vitest";
import { useDictionary } from "../../../../client/useDictionary";
import { useFormatter } from "../../../../client/useFormatter";
import { __gemi_dict__ } from "../../../../i18n/defineDictionary";

/**
 * Islands for the island-dictionary tests (#1095): one reads a dictionary
 * with a param only the browser knows, one only formats, one reads no i18n.
 */

export const strings = {
  "en-US": { rate: "VAT ({{rate}}%)", title: "Cart" },
  "tr-TR": { rate: "KDV (%{{rate}})", title: "Sepet" },
  "de-DE": { rate: "MwSt. ({{rate}} %)", title: "Warenkorb" },
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
