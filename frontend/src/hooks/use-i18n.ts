import { useCallback, useSyncExternalStore } from "react";
import {
  formatNumber,
  formatDate,
  formatRelativeTime,
  getLocale,
  setLocale,
  subscribeLocale,
  translate,
  type TranslationKey,
  type TranslationParams,
} from "@/lib/i18n";

/**
 * React binding for `lib/i18n`. Returns a stable `t` bound to the live
 * locale — components re-render on locale switch via useSyncExternalStore.
 *
 * `t`/`fmt*` are stable across locale switches (identity changes only with
 * the locale), so they are safe in effect deps.
 */
export function useI18n() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);

  const t = useCallback((key: TranslationKey, params?: TranslationParams) => translate(locale, key, params), [locale]);

  return {
    locale,
    setLocale,
    t,
    fmtNumber: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(locale, value, options),
    fmtDate: (value: number | Date, options?: Intl.DateTimeFormatOptions) => formatDate(locale, value, options),
    fmtRelative: (value: number | Date, now?: number) => formatRelativeTime(locale, value, now),
  };
}
