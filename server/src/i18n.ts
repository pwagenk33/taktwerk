// Language on the server: per request from the Accept-Language header the app sends (the language chosen in the
// profile), and per recipient when building e-mails. Domain texts and number formats follow the same choice.
import { AsyncLocalStorage } from "node:async_hooks";
import { MESSAGES, isLocale, pickLocale, registerMessages, setFormatLocaleResolver, setTranslator, translate, trnFor, type Locale } from "@taktwerk/domain";

const store = new AsyncLocalStorage<Locale>();
export const currentLocale = (): Locale => store.getStore() ?? "de";

registerMessages(MESSAGES);
setTranslator((de, ...args) => translate(currentLocale(), de, ...args));
setFormatLocaleResolver(() => `${currentLocale()}-CH`);

/** Runs fn in the given language (a recipient's or a customer's); unknown values mean German. */
export function withLocale<T>(locale: string | null | undefined, fn: () => T): T {
  return store.run(isLocale(locale) ? locale : "de", fn);
}
/** For the request hook: language from Accept-Language. */
export const requestLocale = (header: string | string[] | undefined): Locale => pickLocale(Array.isArray(header) ? header.join(",") : header);
/** Singular or plural in the current language; the count is {0}. */
export const trn = (n: number, one: string, other: string, ...args: (string | number | null | undefined)[]) => trnFor(currentLocale(), n, one, other, ...args);
