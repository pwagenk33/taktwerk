import { DEFAULT_RATES, addMonths, countsExpense, fmtMonthLong } from "@taktwerk/domain";
import { and, desc, eq, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { HttpError, type AppContext } from "../app";
import { customers, invoices, organizations, type BillingSettings, type InvoicePosition, type PostalAddress } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { loadDataset } from "../routes/data";
import { tr } from "@taktwerk/domain";
import { currentLocale, withLocale } from "../i18n";

type Invoice = typeof invoices.$inferSelect;

const money2 = (v: number) => v.toLocaleString(`${currentLocale()}-CH`, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v: number) => v.toLocaleString(`${currentLocale()}-CH`, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const swissDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const round05 = (v: number) => Math.round(v * 20) / 20;
const round2 = (v: number) => Math.round(v * 100) / 100;
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function billingProblem(b: BillingSettings | undefined): string | null {
  if (!b) return tr("Bitte zuerst unter Einstellungen → Rechnung die Absenderadresse und IBAN hinterlegen.");
  if (!b.iban) return tr("Unter Einstellungen → Rechnung fehlt die IBAN.");
  return null;
}

/** Positions for one customer and month: hours per sub-project and rate, approved billable expenses. */
export async function invoicePositions(ctx: AppContext, orgId: string, customerId: string, month: string) {
  const data = await loadDataset(ctx, { id: "", organizationId: orgId, name: "", username: "", email: "", role: "admin" });
  const subs = new Map(
    data.subProjects
      .filter((s) => data.projects.find((p) => p.id === s.projectId)?.customerId === customerId)
      .map((s) => [s.id, { sub: s, project: data.projects.find((p) => p.id === s.projectId)! }]),
  );
  const inMonth = (d: string) => d.startsWith(month);
  const positions: InvoicePosition[] = [];

  // Hours grouped by sub-project and frozen rate (a rate change mid-month gives two lines).
  const groups = new Map<string, { text: string; detail: string; hours: number; rate: number }>();
  for (const e of data.timeEntries) {
    const s = subs.get(e.subProjectId);
    if (!s || !e.billable || !inMonth(e.date)) continue;
    const key = `${e.subProjectId}:${e.hourlyRate}`;
    const g = groups.get(key) ?? { text: `${s.project.name} · ${s.sub.name}`, detail: tr("Leistungen {0}", fmtMonthLong(month)), hours: 0, rate: e.hourlyRate };
    g.hours += e.hours;
    groups.set(key, g);
  }
  for (const g of [...groups.values()].sort((a, b) => a.text.localeCompare(b.text, "de"))) {
    positions.push({ text: g.text, detail: g.detail, quantity: round2(g.hours), unit: "h", unitPrice: g.rate, amount: round05(g.hours * g.rate) });
  }
  const person = new Map(data.employees.map((e) => [e.id, e.name]));
  for (const x of data.expenses.filter((x) => countsExpense(x) && inMonth(x.date) && subs.has(x.subProjectId)).sort((a, b) => a.date.localeCompare(b.date))) {
    const s = subs.get(x.subProjectId)!;
    if (x.category === "Kilometer" && x.km) {
      positions.push({ text: tr("Kilometer {0} · {1}", swissDate(x.date), x.reason), detail: `${s.sub.name} · ${person.get(x.employeeId) ?? ""}`, quantity: x.km, unit: "km", unitPrice: round2(x.amount / x.km), amount: x.amount });
    } else {
      positions.push({ text: `${tr(x.category)} ${swissDate(x.date)} · ${x.reason}`, detail: `${s.sub.name} · ${person.get(x.employeeId) ?? ""}`, quantity: 1, unit: "Stk.", unitPrice: x.amount, amount: x.amount });
    }
  }
  return { positions, customerName: data.customers.find((c) => c.id === customerId)?.name ?? "" };
}

async function nextNumber(ctx: AppContext, orgId: string, year: string) {
  const [last] = await ctx.db
    .select({ number: invoices.number })
    .from(invoices)
    .where(and(eq(invoices.organizationId, orgId), like(invoices.number, `${year}-%`)))
    .orderBy(desc(invoices.number))
    .limit(1);
  const n = last ? Number(last.number.split("-")[1]) + 1 : 1;
  return `${year}-${String(n).padStart(4, "0")}`;
}

export async function createInvoice(ctx: AppContext, orgId: string, customerId: string, month: string, today: string): Promise<Invoice> {
  const [lang] = await ctx.db.select({ locale: customers.locale }).from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, orgId))).limit(1);
  return withLocale(lang?.locale, () => createInvoiceIn(ctx, orgId, customerId, month, today));
}

async function createInvoiceIn(ctx: AppContext, orgId: string, customerId: string, month: string, today: string): Promise<Invoice> {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const [customer] = await ctx.db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, orgId))).limit(1);
  if (!org || !customer) throw new HttpError(404, tr("Kunde nicht gefunden."));
  const problem = billingProblem(org.settings.billing);
  if (problem) throw new HttpError(400, problem);
  if (!customer.billingAddress) throw new HttpError(400, tr("Für diesen Kunden fehlt die Rechnungsadresse."));
  const [existing] = await ctx.db
    .select({ number: invoices.number })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.month, month), eq(invoices.status, "draft")))
    .limit(1);
  if (existing) throw new HttpError(409, tr("Für {0} gibt es bereits den Entwurf {1}.", fmtMonthLong(month), existing.number));

  const { positions } = await invoicePositions(ctx, orgId, customerId, month);
  if (positions.length === 0) throw new HttpError(400, tr("Für {0} gibt es keine verrechenbaren Leistungen oder Spesen.", fmtMonthLong(month)));
  const billing = org.settings.billing!;
  const vatRate = org.settings.vatRate ?? DEFAULT_RATES.vatRate;
  const net = round05(positions.reduce((s, p) => s + p.amount, 0));
  const vat = round05((net * vatRate) / 100);
  const row: Invoice = {
    id: randomUUID(),
    organizationId: orgId,
    customerId,
    number: await nextNumber(ctx, orgId, today.slice(0, 4)),
    month,
    issueDate: today,
    dueDate: addDays(today, billing.paymentDays),
    status: "draft",
    positions,
    net,
    vatRate,
    vat,
    gross: round05(net + vat),
    snapshot: { sender: billing, recipient: customer.billingAddress, customerName: customer.name, appName: org.settings.branding.appName, primaryColor: org.settings.branding.primaryColor, currency: customer.currency, locale: customer.locale },
    sentAt: null,
    paidAt: null,
    bexioId: null,
    createdAt: new Date(),
  };
  await ctx.db.insert(invoices).values(row);
  return row;
}

// ---------- Swiss QR bill ----------

/** Payload per Swiss Payment Standards 2.3 (SPC, version 0200). Unstructured message carries the invoice number. */
export function qrBillPayload(inv: Invoice): string {
  const s = inv.snapshot;
  const addr = (a: PostalAddress) => ["K", a.name, a.street, `${a.zip} ${a.city}`, "", "", a.country || "CH"];
  return [
    "SPC",
    "0200",
    "1",
    s.sender.iban.replace(/\s+/g, ""),
    ...addr(s.sender.address),
    "", "", "", "", "", "", "", // ultimate creditor (unused)
    inv.gross.toFixed(2),
    s.currency ?? "CHF",
    ...addr(s.recipient),
    "NON",
    "",
    withLocale(inv.snapshot.locale, () => tr("Rechnung {0}, {1}", inv.number, fmtMonthLong(inv.month))),
    "EPD",
  ].join("\n");
}

const MM = 72 / 25.4;

/** Draws the payment part (receipt + payment section) at the bottom of the current page, 105 mm high. */
async function drawQrBill(doc: PDFKit.PDFDocument, inv: Invoice) {
  const s = inv.snapshot;
  const pageW = doc.page.width;
  const top = doc.page.height - 105 * MM;
  const png = await QRCode.toBuffer(qrBillPayload(inv), { errorCorrectionLevel: "M", margin: 0, width: 600 });

  doc.save();
  doc.page.margins.bottom = 0;
  // Separation lines with scissors
  doc.moveTo(0, top).lineTo(pageW, top).lineWidth(0.5).dash(2, { space: 2 }).stroke("#000000");
  doc.moveTo(62 * MM, top).lineTo(62 * MM, doc.page.height).stroke();
  doc.undash();
  doc.fillColor("#000000").font("Helvetica").fontSize(7).text("✂", 5 * MM, top - 7, { lineBreak: false });

  const title = (x: number, y: number, t: string, size: number) => doc.font("Helvetica-Bold").fontSize(size).text(t, x, y, { lineBreak: false });
  const heading = (x: number, y: number, t: string, size = 6) => doc.font("Helvetica-Bold").fontSize(size).text(t, x, y, { lineBreak: false });
  const value = (x: number, y: number, lines: string[], size = 8) => {
    doc.font("Helvetica").fontSize(size);
    let yy = y;
    for (const l of lines) {
      doc.text(l, x, yy, { lineBreak: false });
      yy += size + 1.5;
    }
    return yy;
  };
  const addressLines = (a: PostalAddress) => [a.name, a.street, `${a.zip} ${a.city}`].filter(Boolean);
  const iban = s.sender.iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

  // Receipt (left, 62 mm)
  let x = 5 * MM;
  let y = top + 5 * MM;
  title(x, y, tr("Empfangsschein"), 11);
  y += 7 * MM;
  heading(x, y, tr("Konto / Zahlbar an"));
  y = value(x, y + 8, [iban, ...addressLines(s.sender.address)]);
  y += 6;
  heading(x, y, tr("Referenz"));
  y = value(x, y + 8, [tr("Rechnung {0}", inv.number)]);
  y += 6;
  heading(x, y, tr("Zahlbar durch"));
  y = value(x, y + 8, addressLines(s.recipient));
  y = top + 68 * MM;
  heading(x, y, tr("Währung"));
  heading(x + 15 * MM, y, tr("Betrag"));
  value(x, y + 8, [s.currency ?? "CHF"]);
  value(x + 15 * MM, y + 8, [money2(inv.gross)]);
  heading(x + 38 * MM, top + 82 * MM, tr("Annahmestelle"));

  // Payment part (right, 148 mm)
  x = 67 * MM;
  y = top + 5 * MM;
  title(x, y, tr("Zahlteil"), 11);
  const qrSize = 46 * MM;
  const qrY = top + 17 * MM;
  doc.image(png, x, qrY, { width: qrSize, height: qrSize });
  // Swiss cross in the centre
  const cx = x + qrSize / 2;
  const cy = qrY + qrSize / 2;
  const c = 7 * MM;
  doc.rect(cx - c / 2, cy - c / 2, c, c).fill("#000000");
  doc.rect(cx - c / 2 + 0.6 * MM, cy - c / 2 + 0.6 * MM, c - 1.2 * MM, c - 1.2 * MM).fill("#000000");
  doc.rect(cx - 0.7 * MM, cy - 2.2 * MM, 1.4 * MM, 4.4 * MM).fill("#FFFFFF");
  doc.rect(cx - 2.2 * MM, cy - 0.7 * MM, 4.4 * MM, 1.4 * MM).fill("#FFFFFF");
  doc.fillColor("#000000");
  y = top + 68 * MM;
  heading(x, y, tr("Währung"), 8);
  heading(x + 20 * MM, y, tr("Betrag"), 8);
  value(x, y + 10, [s.currency ?? "CHF"], 10);
  value(x + 20 * MM, y + 10, [money2(inv.gross)], 10);

  x = 118 * MM;
  y = top + 5 * MM;
  heading(x, y, tr("Konto / Zahlbar an"), 8);
  y = value(x, y + 10, [iban, ...addressLines(s.sender.address)], 10);
  y += 8;
  heading(x, y, tr("Referenz"), 8);
  y = value(x, y + 10, [tr("Rechnung {0}", inv.number)], 10);
  y += 8;
  heading(x, y, tr("Zusätzliche Informationen"), 8);
  y = value(x, y + 10, [tr("{0}, zahlbar bis {1}", fmtMonthLong(inv.month), swissDate(inv.dueDate))], 10);
  y += 8;
  heading(x, y, tr("Zahlbar durch"), 8);
  value(x, y + 10, addressLines(s.recipient), 10);
  doc.restore();
}

export function renderInvoicePdf(inv: Invoice): Promise<Buffer> {
  return withLocale(inv.snapshot.locale, () => renderInvoicePdfIn(inv));
}

async function renderInvoicePdfIn(inv: Invoice): Promise<Buffer> {
  const s = inv.snapshot;
  const doc = new PDFDocument({ size: "A4", margins: { top: 50, bottom: 60, left: 50, right: 50 }, bufferPages: true, info: { Title: tr("Rechnung {0}", inv.number), Author: s.sender.address.name } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 100;
  const INK = "#1D1D1F";
  const MUTED = "#6E6E73";

  // Sender line and recipient block (window envelope position)
  doc.fillColor(s.primaryColor).font("Helvetica-Bold").fontSize(16).text(s.sender.address.name, 50, 50);
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(`${s.sender.address.street} · ${s.sender.address.zip} ${s.sender.address.city}${s.sender.vatNumber ? ` · ${s.sender.vatNumber}` : ""}`);
  doc.fillColor(INK).font("Helvetica").fontSize(10).text([s.recipient.name, s.recipient.street, `${s.recipient.zip} ${s.recipient.city}`].filter(Boolean).join("\n"), 50, 130);

  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  const meta: [string, string][] = [
    [tr("Rechnungsnummer"), inv.number],
    [tr("Rechnungsdatum"), swissDate(inv.issueDate)],
    [tr("Zahlbar bis"), swissDate(inv.dueDate)],
    [tr("Leistungsperiode"), fmtMonthLong(inv.month)],
  ];
  meta.forEach(([k, v], i) => {
    doc.fillColor(MUTED).text(k, 350, 130 + i * 13, { width: 100, lineBreak: false });
    doc.fillColor(INK).text(v, 450, 130 + i * 13, { width: 95, align: "right", lineBreak: false });
  });

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(14).text(tr("Rechnung {0}", inv.number), 50, 215);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(tr("Leistungen und Spesen {0} für {1}", fmtMonthLong(inv.month), s.customerName), 50, 234);

  // Positions table
  const cols = [
    { label: tr("Beschreibung"), w: W * 0.5 },
    { label: tr("Menge"), w: W * 0.13, r: true },
    { label: tr("Ansatz"), w: W * 0.17, r: true },
    { label: tr("Betrag {0}", s.currency ?? "CHF"), w: W * 0.2, r: true },
  ];
  let y = 262;
  const header = () => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    let x = 50;
    for (const c of cols) {
      doc.text(c.label, x + 3, y, { width: c.w - 6, align: c.r ? "right" : "left", lineBreak: false });
      x += c.w;
    }
    doc.moveTo(50, y + 12).lineTo(50 + W, y + 12).lineWidth(0.8).stroke(INK);
    y += 16;
  };
  header();
  const bottomLimit = doc.page.height - 105 * MM - 120;
  for (const p of inv.positions) {
    doc.font("Helvetica").fontSize(9);
    const h = doc.heightOfString(p.text, { width: cols[0]!.w - 6 }) + (p.detail ? 11 : 0) + 8;
    if (y + h > bottomLimit) {
      doc.addPage();
      y = 50;
      header();
    }
    doc.fillColor(INK).text(p.text, 53, y + 3, { width: cols[0]!.w - 6 });
    if (p.detail) doc.fillColor(MUTED).fontSize(7.5).text(p.detail, 53, doc.y, { width: cols[0]!.w - 6 });
    doc.fillColor(INK).fontSize(9);
    doc.text(`${qty(p.quantity)} ${tr(p.unit)}`, 50 + cols[0]!.w + 3, y + 3, { width: cols[1]!.w - 6, align: "right", lineBreak: false });
    doc.text(money2(p.unitPrice), 50 + cols[0]!.w + cols[1]!.w + 3, y + 3, { width: cols[2]!.w - 6, align: "right", lineBreak: false });
    doc.text(money2(p.amount), 50 + cols[0]!.w + cols[1]!.w + cols[2]!.w + 3, y + 3, { width: cols[3]!.w - 6, align: "right", lineBreak: false });
    y += h;
    doc.moveTo(50, y).lineTo(50 + W, y).lineWidth(0.4).stroke("#E3E3E6");
  }
  if (y + 70 > bottomLimit) {
    doc.addPage();
    y = 50;
  }
  y += 8;
  const totals: [string, string, boolean][] = [
    [tr("Total netto"), money2(inv.net), false],
    [tr("MwSt {0} %", inv.vatRate.toLocaleString(`${currentLocale()}-CH`)), money2(inv.vat), false],
    [tr("Total {0}", s.currency ?? "CHF"), money2(inv.gross), true],
  ];
  for (const [k, v, bold] of totals) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(INK);
    doc.text(k, 50 + W * 0.5, y, { width: W * 0.3 - 6, align: "right", lineBreak: false });
    doc.text(v, 50 + W * 0.8, y, { width: W * 0.2 - 3, align: "right", lineBreak: false });
    y += bold ? 18 : 14;
  }
  doc.moveTo(50 + W * 0.5, y - 4).lineTo(50 + W, y - 4).lineWidth(0.8).stroke(INK);
  y += 10;
  doc.font("Helvetica").fontSize(9).fillColor(INK).text(s.sender.footer || tr("Zahlbar innert {0} Tagen bis {1} mit dem Zahlteil unten. Besten Dank für die Zusammenarbeit.", s.sender.paymentDays, swissDate(inv.dueDate)), 50, y, { width: W });

  // QR bill on the last page (the Swiss QR bill exists for CHF and EUR only).
  if ((s.currency ?? "CHF") !== "USD") {
    doc.switchToPage(doc.bufferedPageRange().count - 1);
    await drawQrBill(doc, inv);
  }
  doc.end();
  return done;
}

export function sendInvoice(ctx: AppContext, inv: Invoice, recipients: string[]) {
  return withLocale(inv.snapshot.locale, () => sendInvoiceIn(ctx, inv, recipients));
}

async function sendInvoiceIn(ctx: AppContext, inv: Invoice, recipients: string[]) {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, inv.organizationId)).limit(1);
  if (!org) throw new HttpError(404, tr("Organisation nicht gefunden."));
  const pdf = await renderInvoicePdf(inv);
  const mail = actionMail(org.settings.branding, {
    to: recipients.join(", "),
    subject: tr("{0}: Rechnung {1} – {2}", org.name, inv.number, fmtMonthLong(inv.month)),
    greeting: tr("Guten Tag"),
    lines: [
      tr("Im Anhang finden Sie unsere Rechnung {0} für {1} über {2} {3}.", inv.number, fmtMonthLong(inv.month), inv.snapshot.currency ?? "CHF", money2(inv.gross)),
      (inv.snapshot.currency ?? "CHF") === "USD" ? tr("Zahlbar bis {0} auf das angegebene Konto.", swissDate(inv.dueDate)) : tr("Zahlbar bis {0}; der Zahlteil mit QR-Code befindet sich auf der letzten Seite.", swissDate(inv.dueDate)),
    ],
    footer: tr("Bei Fragen antworten Sie einfach auf diese E-Mail. Freundliche Grüsse, {0}", org.name),
  });
  await ctx.mailer.send({ ...mail, attachments: [{ filename: tr("Rechnung-{0}.pdf", inv.number), content: pdf, contentType: "application/pdf" }] });
}

export const previousMonth = (today: string) => addMonths(today.slice(0, 7), -1);
