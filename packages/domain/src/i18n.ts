// Translations. German text is the key: tr("Speichern") gives «Enregistrer» in French. A missing entry falls back
// to German, so a new text never breaks anything. All texts live in messages.ts; `npm run i18n` lists the gaps.
// The browser and the server each plug in how they pick the language (setTranslator). Constants built at import
// time stay German and are translated where they are shown.
// The table is registered, not imported, so the browser only downloads it when someone uses French or English:
// the server registers it at start, the web app loads it on demand (see web/src/main.tsx).

export type Locale = "de" | "fr" | "en";
export const LOCALES: { id: Locale; label: string }[] = [
  { id: "de", label: "Deutsch" },
  { id: "fr", label: "Français" },
  { id: "en", label: "English" },
];
export const isLocale = (v: unknown): v is Locale => v === "de" || v === "fr" || v === "en";
/** First supported language in an Accept-Language header or a list of browser languages; German otherwise. */
export function pickLocale(wanted: string | readonly string[] | null | undefined): Locale {
  const list = typeof wanted === "string" ? wanted.split(",") : wanted ?? [];
  for (const raw of list) {
    const short = raw.trim().slice(0, 2).toLowerCase();
    if (isLocale(short)) return short;
  }
  return "de";
}

type Arg = string | number | null | undefined;
export type Translator = (de: string, ...args: Arg[]) => string;

type Row = readonly [de: string, fr: string, en: string];
let rows: readonly Row[] = [];
const dicts = new Map<Locale, Map<string, string>>();
/** Plugs in the translation table (messages.ts); without it every text stays German. */
export function registerMessages(table: readonly Row[]) {
  rows = table;
  dicts.clear();
}
export function dictionary(locale: Locale): Map<string, string> {
  let d = dicts.get(locale);
  if (!d) {
    d = new Map();
    const col = locale === "fr" ? 1 : 2;
    if (locale !== "de") for (const row of rows) if (row[col]) d.set(row[0], row[col]);
    dicts.set(locale, d);
  }
  return d;
}

const fill = (s: string, args: Arg[]) => (args.length ? s.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? "")) : s);
/** Translates into the given language; {0}, {1} … are replaced by the arguments. */
export function translate(locale: Locale, de: string, ...args: Arg[]): string {
  return fill(locale === "de" ? de : dictionary(locale).get(de) ?? de, args);
}

let impl: Translator = (de, ...args) => fill(de, args);
/** Translates into the current language (set by the browser or per request on the server). */
export const tr: Translator = (de, ...args) => impl(de, ...args);
export function setTranslator(fn: Translator) { impl = fn; }

/** Singular or plural by count, e.g. trn(n, "{0} Buchung", "{0} Buchungen"); the count is {0}. */
export function trnFor(locale: Locale, n: number, one: string, other: string, ...args: Arg[]): string {
  return translate(locale, new Intl.PluralRules(`${locale}-CH`).select(n) === "one" ? one : other, n, ...args);
}
