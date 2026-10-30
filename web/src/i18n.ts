// The browser's language: chosen in the profile (saved here and on the server) or taken from the browser.
// Texts and number formats switch together; changing the language reloads the page.
import { LOCALES, isLocale, pickLocale, setFormatLocale, setTranslator, translate, trnFor, type Locale } from "@taktwerk/domain";

export { LOCALES, type Locale };
const STORE_KEY = "rt.locale";

function detect(): Locale {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (isLocale(stored)) return stored;
  } catch { /* private mode */ }
  return pickLocale(typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : []);
}

export const locale: Locale = detect();
/** BCP 47 tag for Intl formatting: de-CH, fr-CH or en-CH. */
export const intlLocale = `${locale}-CH`;
setFormatLocale(intlLocale);
if (typeof document !== "undefined") document.documentElement.lang = intlLocale;

type Arg = string | number | null | undefined;
/** Translates a German text; {0}, {1} … are replaced by the arguments. */
export const tr = (de: string, ...args: Arg[]): string => translate(locale, de, ...args);
setTranslator(tr);
/** Singular or plural by count, e.g. trn(n, "{0} Buchung", "{0} Buchungen"); the count is {0}. */
export const trn = (n: number, one: string, other: string, ...args: Arg[]): string => trnFor(locale, n, one, other, ...args);

/** Saves the language for this browser and reloads, so every text and number format switches at once. */
export function setLocale(next: Locale, reload = true) {
  try { localStorage.setItem(STORE_KEY, next); } catch { /* ignore */ }
  if (reload && next !== locale) location.reload();
}
