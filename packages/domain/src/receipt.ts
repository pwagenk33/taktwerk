import { EXPENSE_CATEGORIES, VAT_RATES, type ExpenseCategory } from "./types";

/** What could be read from a receipt's OCR text; every field is optional and meant to be checked by the person. */
export interface ReceiptGuess {
  amount?: number;
  date?: string;
  vatRate?: number;
  category?: ExpenseCategory;
  /** Merchant or first meaningful line, as a proposal for the reason. */
  merchant?: string;
}

const CATEGORY_HINTS: [RegExp, ExpenseCategory][] = [
  [/\b(sbb|cff|ffs|bls|zvv|tnw|postauto|bahn|zug|billett|ticket|taxi|uber|parking|parkhaus|tankstelle|benzin|diesel|flug|swiss|easyjet|lufthansa|mietwagen|europcar|hertz|sixt|mobility)\b/i, "Reise"],
  [/\b(hotel|hostel|pension|übernachtung|uebernachtung|zimmer|nacht|booking\.com|airbnb)\b/i, "Unterkunft"],
  [/\b(restaurant|ristorante|café|cafe|bar|bistro|pizzeria|menu|menü|mittagessen|lunch|dinner|take ?away|kaffee|coop|migros|denner|aldi|lidl|bäckerei|baeckerei|metzgerei|kiosk|mcdonald|burger)\b/i, "Verpflegung"],
  [/\b(lizenz|licence|license|subscription|abo|abonnement|software|cloud|microsoft|adobe|atlassian|jira|github|google workspace|saas)\b/i, "Lizenzen"],
  [/\b(digitec|galaxus|brack|interdiscount|fust|media ?markt|kabel|adapter|maus|tastatur|monitor|drucker|toner|papier|büro|buero|office)\b/i, "Material"],
];

const num = (s: string) => Number(s.replace(/'/g, "").replace(/\s/g, "").replace(",", "."));

/** Parses a Swiss receipt (German, French or Italian labels) into a proposal for the expense form. */
export function parseReceipt(text: string, today: string): ReceiptGuess {
  const raw = text.replace(/\r/g, "");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const guess: ReceiptGuess = {};

  // Amount: a line with Total/Summe/Betrag/Montant/Totale wins; else the largest plausible amount with two decimals.
  const money = /(?:chf|fr\.?|sfr)?\s*(\d{1,3}(?:[' ]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})\b/gi;
  const totals = lines.filter((l) => /\b(total|summe|betrag|gesamt|montant|totale|zu zahlen|à payer|bezahlt)\b/i.test(l) && !/\b(mwst|tva|iva|vat|rabatt|rückgeld|retour)\b/i.test(l));
  const pick = (ls: string[]) => {
    let best: number | undefined;
    for (const l of ls) for (const m of l.replace(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ").matchAll(money)) {
      const v = num(m[1]);
      if (v > 0 && v < 100000 && (best === undefined || v > best)) best = v;
    }
    return best;
  };
  guess.amount = pick(totals) ?? pick(lines.filter((l) => !/\b(mwst|tva|iva|vat|tel|uid|che-|iban|kto)\b/i.test(l)));

  // Date: 19.10.2026, 19.10.26, 19/10/2026 or 2026-10-19; only dates up to today and not older than two years.
  const dates: string[] = [];
  for (const m of raw.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})\b/g)) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    dates.push(`${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  }
  for (const m of raw.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) dates.push(`${m[1]}-${m[2]}-${m[3]}`);
  const floor = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
  const valid = dates.filter((d) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d) && d <= today && d >= floor);
  if (valid.length) guess.date = valid.sort().at(-1);

  // VAT: an explicit rate on the receipt, only if it is one of the Swiss rates.
  for (const m of raw.matchAll(/(\d{1,2}[.,]\d)\s*%/g)) {
    const r = num(m[1]);
    if ((VAT_RATES as readonly number[]).includes(r)) { guess.vatRate = r; break; }
  }
  if (guess.vatRate === undefined && /\b(mwst|tva|iva|vat)\b/i.test(raw) && /\b(8[.,]1|2[.,]6|3[.,]8)\b/.test(raw)) {
    const m = raw.match(/\b(8[.,]1|2[.,]6|3[.,]8)\b/);
    if (m) guess.vatRate = num(m[1]);
  }

  // Category from keywords; merchant is the first line that is mostly letters and no label.
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(raw)) { guess.category = cat; break; }
  const merchant = lines.find((l) => /[A-Za-zÀ-ž]{3,}/.test(l) && !/\d{2}[.:]\d{2}/.test(l) && !/\b(quittung|kassenbon|beleg|rechnung|receipt|facture|ricevuta|tel|uid|mwst|tva|total|datum|date)\b/i.test(l) && l.replace(/[^A-Za-zÀ-ž ]/g, "").length >= l.length * 0.6);
  if (merchant) guess.merchant = merchant.replace(/\s{2,}/g, " ").slice(0, 60);
  void EXPENSE_CATEGORIES;
  return guess;
}
