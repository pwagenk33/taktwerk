import { describe, expect, it } from "vitest";
import { parseReceipt } from "../receipt";

const TODAY = "2026-10-19";

describe("parseReceipt", () => {
  it("reads total, date, VAT and category from a Swiss restaurant receipt", () => {
    const text = `Ristorante Da Gino
Bahnhofstrasse 12, 8001 Zürich
Tel 044 123 45 67   CHE-123.456.789 MWST
Datum 16.10.2026  12:41
2 x Pizza Margherita        36.00
1 x Mineral 5dl              4.50
Total CHF                   40.50
inkl. 8.1% MWST              3.04
Bezahlt Karte               40.50
Vielen Dank für Ihren Besuch`;
    expect(parseReceipt(text, TODAY)).toEqual({ amount: 40.5, date: "2026-10-16", vatRate: 8.1, category: "Verpflegung", merchant: "Ristorante Da Gino" });
  });

  it("handles SBB tickets with apostrophe thousands, short years and no VAT line", () => {
    const text = `SBB CFF FFS
Billett Basel SBB - Zürich HB
2. Klasse Halbtax
Gültig 02.10.26
Preis CHF 1'234.00`;
    const g = parseReceipt(text, TODAY);
    expect(g.amount).toBe(1234);
    expect(g.date).toBe("2026-10-02");
    expect(g.category).toBe("Reise");
    expect(g.vatRate).toBeUndefined();
  });

  it("ignores future dates and picks the largest amount without a total line", () => {
    const g = parseReceipt("Coop Pronto\n12.5\n0.95\n21.70 \n 25.12.2027", TODAY);
    expect(g.amount).toBe(21.7);
    expect(g.date).toBeUndefined();
    expect(g.category).toBe("Verpflegung");
  });

  it("returns an empty guess for noise", () => {
    expect(parseReceipt("", TODAY)).toEqual({});
  });
});
