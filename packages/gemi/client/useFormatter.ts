import { useMemo } from "react";
import {
  createFormatter,
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  type Formatter,
} from "../i18n/formatter";
import { useRouteData } from "./useRouteData";

/**
 * Format dates, numbers, relative times and lists in the active locale and the
 * app's time zone.
 *
 * ```tsx
 * const format = useFormatter();
 * format.date(order.createdAt, { dateStyle: "long" });
 * format.number(1199.88, { style: "currency", currency: "USD" });
 * format.date(order.createdAt, { timeZone: "Europe/Istanbul" }); // per call
 * ```
 *
 * The locale and zone both come from the page payload, so the server render
 * and the hydrating browser format with the same ones. Prefer this to
 * `toLocaleDateString()`, which uses the runtime's locale and zone and so
 * differs between the two.
 *
 * Pass `options` to pin a zone for one subtree (`useFormatter({ timeZone })`).
 */
export function useFormatter(
  options: { locale?: string; timeZone?: string } = {},
): Formatter {
  const { i18n } = useRouteData();
  const locale =
    options.locale ?? i18n?.currentLocale ?? i18n?.defaultLocale ?? "en-US";
  // An explicit zone is trusted and throws from `Intl` if it is wrong, like a
  // per-call one. The payload's was validated on the server; the check is for
  // a hand-built payload (tests, an older server) that has none.
  const timeZone =
    options.timeZone ??
    (isValidTimeZone(i18n?.timeZone) ? i18n.timeZone : DEFAULT_TIME_ZONE);

  return useMemo(
    () => createFormatter({ locale, timeZone }),
    [locale, timeZone],
  );
}
