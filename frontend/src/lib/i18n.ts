import en from "@/locales/en.json";
import id from "@/locales/id.json";

/**
 * Lightweight i18n — no runtime dependency.
 *
 * - Keys are dot paths typed from `en.json` (the source of truth): a typo'd
 *   key is a compile error, never a silent fallback.
 * - Values are `string` or `{ one?, other }` plural forms resolved via
 *   `Intl.PluralRules` (the `count` param selects the form).
 * - Interpolation: `{{name}}` placeholders filled from the params object.
 * - Lookup falls back current locale → `en` → the key itself (a missing key
 *   renders visibly instead of blanking the UI).
 * - Dictionaries are statically imported (both locales ≈ 27 KB raw, tiny
 *   gzipped); switch to code-splitting only if locales multiply.
 */

export const SUPPORTED_LOCALES = ["en", "id"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  id: "Bahasa Indonesia",
};

const STORAGE_KEY = "kawai-locale";
const FALLBACK_LOCALE: Locale = "en";

type PluralForms = { one?: string; other: string };

/** Type guard — narrows `unknown` dictionary nodes to a plural message. */
export function isPluralForms(value: unknown): value is PluralForms {
  return typeof value === "object" && value !== null && "other" in value && typeof value.other === "string";
}

/** Dot paths into the dictionary, leaves only. */
type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : T[K] extends PluralForms ? K : `${K}.${Paths<T[K]>}`;
}[keyof T & string];

export type TranslationKey = Paths<typeof en>;

export type TranslationParams = Record<string, string | number>;

const DICTIONARIES: Record<Locale, unknown> = { en, id };

// ---------------------------------------------------------------------------
// Locale store (module-level; React reads it via useSyncExternalStore)

type Listener = () => void;
const listeners = new Set<Listener>();

function isLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Stored override → navigator preference → "en". */
function detectLocale(): Locale {
  if (typeof window === "undefined") return FALLBACK_LOCALE;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  const candidates = window.navigator.languages ?? [window.navigator.language];
  for (const candidate of candidates) {
    const base = candidate.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return FALLBACK_LOCALE;
}

let currentLocale: Locale = detectLocale();

// Mirror setLocale's document lang at first load — an id-locale user must
// not start with <html lang="en"> from index.html.
if (typeof document !== "undefined") {
  document.documentElement.lang = currentLocale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Translate runtime

function lookup(dict: unknown, key: string): string | PluralForms | undefined {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = Reflect.get(node, part);
  }
  if (typeof node === "string") return node;
  if (isPluralForms(node)) return node;
  return undefined;
}

function selectPlural(message: PluralForms, locale: Locale, count: number): string {
  if (message.one === undefined) return message.other;
  const category = new Intl.PluralRules(locale).select(count);
  return message[category as "one"] ?? message.other;
}

function interpolate(template: string, params: TranslationParams | undefined, key: string): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
    const value = params[name];
    if (value === undefined) {
      if (import.meta.env.DEV) {
        console.warn(`[i18n] missing param "${name}" for key "${key}"`);
      }
      return placeholder;
    }
    return String(value);
  });
}

/**
 * Resolve a translation key in `locale`, falling back to `en`, then the key.
 * Call the returned `t` from `useI18n()` in components so locale switches
 * re-render; this bare function is for non-React call sites.
 */
export function translate(locale: Locale, key: TranslationKey, params?: TranslationParams): string {
  const resolved =
    lookup(DICTIONARIES[locale], key) ??
    (locale === FALLBACK_LOCALE ? undefined : lookup(DICTIONARIES[FALLBACK_LOCALE], key));

  if (resolved === undefined) {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] missing translation key "${key}" (locale "${locale}")`);
    }
    return key;
  }

  const message = typeof resolved === "string" ? resolved : selectPlural(resolved, locale, Number(params?.count ?? 0));

  return interpolate(message, params, key);
}

/** Translate with an explicit locale — used by surfaces pinned to one
 *  language regardless of the app locale (the QRIS money flow stays
 *  Indonesian by design). */
export function translateFixed(key: TranslationKey, params?: TranslationParams): string {
  return translate("id", key, params);
}

// ---------------------------------------------------------------------------
// Intl formatting helpers (locale-aware, for the run/session timestamps)

export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(locale: Locale, value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/** "3 minutes ago" / "3 menit lalu" — pass the target locale explicitly so
 *  a pinned surface formats consistently. */
export function formatRelativeTime(locale: Locale, value: number | Date, now: number = Date.now()): string {
  const timestamp = typeof value === "number" ? value : value.getTime();
  const deltaMs = timestamp - now;
  const absMs = Math.abs(deltaMs);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (absMs >= unitMs) {
      return formatter.format(Math.round(deltaMs / unitMs), unit);
    }
  }
  return formatter.format(Math.round(deltaMs / 1000), "second");
}
