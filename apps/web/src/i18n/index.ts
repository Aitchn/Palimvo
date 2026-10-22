import i18next, { type i18n as I18n } from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, isLocale, negotiate, type Locale } from "@palimvo/i18n/negotiate";
import { loadLocale } from "@palimvo/i18n/load";

const KEY = "palimvo.locale";

function stored(): Locale | undefined {
  try {
    const value = localStorage.getItem(KEY);
    if (isLocale(value)) return value;
  } catch {
    /* storage blocked: follow the browser */
  }
  return undefined;
}

/** What the person picked, else the browser's language list, else English. */
export function initialLocale(): Locale {
  return stored() ?? negotiate(typeof navigator === "undefined" ? undefined : navigator.languages);
}

async function ensureBundle(instance: I18n, locale: Locale): Promise<void> {
  if (instance.hasResourceBundle(locale, "translation")) return;
  instance.addResourceBundle(locale, "translation", await loadLocale(locale), true, true);
}

const latest = new WeakMap<I18n, number>();

function announce(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

/**
 * Sets the interface language. Only the chosen locale (and English, the fallback) is ever
 * downloaded; the other files stay on the server until someone switches to them.
 */
export async function setLocale(locale: Locale, instance: I18n = i18next): Promise<void> {
  const mine = (latest.get(instance) ?? 0) + 1;
  latest.set(instance, mine);
  await Promise.all([ensureBundle(instance, locale), ensureBundle(instance, DEFAULT_LOCALE)]);
  // A newer choice made while this one was downloading wins, whichever finishes first.
  if (latest.get(instance) !== mine) return;
  await instance.changeLanguage(locale);
  if (latest.get(instance) === mine) announce(locale);
}

/** Remembers the choice across visits, then applies it. */
export async function chooseLocale(locale: Locale, instance: I18n = i18next): Promise<void> {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    /* not remembered, still applied */
  }
  await setLocale(locale, instance);
}

/** Creates a separate instance (tests); the app uses the shared one from {@link initI18n}. */
export async function createI18n(locale: Locale): Promise<I18n> {
  const instance = i18next.createInstance();
  await instance
    .use(ICU)
    .use(initReactI18next)
    .init({
      lng: locale,
      fallbackLng: DEFAULT_LOCALE,
      resources: {},
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
      returnNull: false,
    });
  await setLocale(locale, instance);
  return instance;
}

let ready: Promise<I18n> | undefined;

/** Initialises the shared instance once and resolves when the first locale is loaded. */
export function initI18n(locale: Locale = initialLocale()): Promise<I18n> {
  ready ??= (async () => {
    await i18next
      .use(ICU)
      .use(initReactI18next)
      .init({
        lng: locale,
        fallbackLng: DEFAULT_LOCALE,
        resources: {},
        interpolation: { escapeValue: false },
        react: { useSuspense: false },
      });
    await setLocale(locale);
    return i18next;
  })();
  return ready;
}

export { i18next };
