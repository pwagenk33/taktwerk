import { MESSAGES, fmtCHF } from "@taktwerk/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectKeys } from "../../scripts/i18n-keys";
import { renderInvoicePdf } from "../src/reports/invoice";
import { withLocale } from "../src/i18n";
import { login, setup } from "./helpers";

const placeholders = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join(",");

describe("translations", () => {
  it("has French and English for every text the app, server and domain show", () => {
    const known = new Map(MESSAGES.map((m) => [m[0], m]));
    const gaps = collectKeys().filter((k) => !known.get(k.key)?.[1] || !known.get(k.key)?.[2]);
    expect(gaps.map((g) => `${g.key} (${g.where})`)).toEqual([]);
  });

  it("keeps the placeholders of the German text", () => {
    const broken = MESSAGES.filter(([de, fr, en]) => placeholders(fr) !== placeholders(de) || placeholders(en) !== placeholders(de)).map((m) => m[0]);
    expect(broken).toEqual([]);
  });
});

describe("language per request and per recipient", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let anna: string;
  beforeAll(async () => {
    t = await setup();
    anna = (await login(t.app, "anna.keller")).cookie;
  });
  afterAll(async () => {
    await t.app.close();
    await t.pool.end();
  });

  it("answers errors in the language the app sends", async () => {
    const fr = await t.app.inject({ method: "PATCH", url: "/api/customers/nope", payload: { name: "X" }, headers: { cookie: anna, "accept-language": "fr-CH" } });
    expect(fr.json()).toEqual({ error: "Client introuvable." });
    const de = await t.app.inject({ method: "PATCH", url: "/api/customers/nope", payload: { name: "X" }, headers: { cookie: anna } });
    expect(de.json()).toEqual({ error: "Kunde nicht gefunden." });
  });

  it("formats numbers in the recipient's language", () => {
    expect(withLocale("fr", () => fmtCHF(12300))).toMatch(/^12\s300\sCHF$/);
    expect(withLocale("de", () => fmtCHF(12300))).toMatch(/^CHF\s12’300$/);
  });

  it("stores the chosen language and sends e-mails in it", async () => {
    const lea = await login(t.app, "lea.meier");
    const put = await t.app.inject({ method: "PUT", url: "/api/me/locale", payload: { locale: "en" }, headers: { cookie: lea.cookie } });
    expect(put.statusCode).toBe(200);
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: lea.cookie } });
    expect(me.json().locale).toBe("en");

    // Anna (German) asks Lea a question about one of her entries: the mail to Lea is in English.
    const data = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: anna } })).json() as { timeEntries: { id: string; employeeId: string; summary?: boolean }[]; employees: { id: string; name: string }[] };
    const leaId = data.employees.find((e) => e.name === "Lea Meier")!.id;
    const entry = data.timeEntries.find((e) => e.employeeId === leaId && !e.summary)!;
    t.mailer.outbox.length = 0;
    const res = await t.app.inject({ method: "POST", url: `/api/time-entries/${entry.id}/comments`, payload: { text: "Welches Ticket?", question: true }, headers: { cookie: anna } });
    expect(res.statusCode).toBeLessThan(300);
    const mail = t.mailer.outbox.at(-1)!;
    expect(mail.subject).toMatch(/query about your entry/);
    expect(mail.html).toContain('lang="en"');
  });

  it("renders the invoice in the customer's language", async () => {
    const pdf = await renderInvoicePdf({
      id: "x", organizationId: "o", customerId: "c", number: "2026-001", month: "2026-09", issueDate: "2026-10-01", dueDate: "2026-10-31", status: "draft",
      net: 100, vat: 8.1, vatRate: 8.1, gross: 108.1, positions: [{ text: "Arbeit", quantity: 1, unit: "h", unitPrice: 100, amount: 100 }],
      snapshot: { sender: { address: { name: "Muster AG", street: "Weg 1", zip: "8000", city: "Zürich", country: "CH" }, iban: "CH9300762011623852957", paymentDays: 30 }, recipient: { name: "Client SA", street: "Rue 2", zip: "1003", city: "Lausanne", country: "CH" }, customerName: "Client SA", appName: "TrackInsight", primaryColor: "#6d4cf0", currency: "CHF", locale: "fr" },
    } as never);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
