import { DEFAULT_RATES, addMonths, countsExpense, fmtMonthLong } from "@taktwerk/domain";
import { and, desc, eq, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { HttpError, type AppContext } from "../app";
import { customers, invoices, organizations, type BillingSettings, type InvoicePosition, type PostalAddress } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { loadDataset } from "../routes/data";

type Invoice = typeof invoices.$inferSelect;

const money2 = (v: number) => v.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v: number) => v.toLocaleString("de-CH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const swissDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const round05 = (v: number) => Math.round(v * 20) / 20;
const round2 = (v: number) => Math.round(v * 100) / 100;
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function billingProblem(b: BillingSettings | undefined): string | null {
  if (!b) return "Bitte zuerst unter Einstellungen → Rechnung die Absenderadresse und IBAN hinterlegen.";
  if (!b.iban) return "Unter Einstellungen → Rechnung fehlt die IBAN.";
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
    const g = groups.get(key) ?? { text: `${s.project.name} · ${s.sub.name}`, detail: `Leistungen ${fmtMonthLong(month)}`, hours: 0, rate: e.hourlyRate };
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
      positions.push({ text: `Kilometer ${swissDate(x.date)} · ${x.reason}`, detail: `${s.sub.name} · ${person.get(x.employeeId) ?? ""}`, quantity: x.km, unit: "km", unitPrice: round2(x.amount / x.km), amount: x.amount });
    } else {
      positions.push({ text: `${x.category} ${swissDate(x.date)} · ${x.reason}`, detail: `${s.sub.name} · ${person.get(x.employeeId) ?? ""}`, quantity: 1, unit: "Stk.", unitPrice: x.amount, amount: x.amount });
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
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const [customer] = await ctx.db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, orgId))).limit(1);
  if (!org || !customer) throw new HttpError(404, "Kunde nicht gefunden.");
  const problem = billingProblem(org.settings.billing);
  if (problem) throw new HttpError(400, problem);
  if (!customer.billingAddress) throw new HttpError(400, "Für diesen Kunden fehlt die Rechnungsadresse.");
  const [existing] = await ctx.db
    .select({ number: invoices.number })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.month, month), eq(invoices.status, "draft")))
    .limit(1);
  if (existing) throw new HttpError(409, `Für ${fmtMonthLong(month)} gibt es bereits den Entwurf ${existing.number}.`);

  const { positions } = await invoicePositions(ctx, orgId, customerId, month);
  if (positions.length === 0) throw new HttpError(400, `Für ${fmtMonthLong(month)} gibt es keine verrechenbaren Leistungen oder Spesen.`);
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
    snapshot: { sender: billing, recipient: customer.billingAddress, customerName: customer.name, appName: org.settings.branding.appName, primaryColor: org.settings.branding.primaryColor },
    sentAt: null,
    paidAt: null,
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
    "CHF",
    ...addr(s.recipient),
    "NON",
    "",
    `Rechnung ${inv.number}, ${fmtMonthLong(inv.month)}`,
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
  title(x, y, "Empfangsschein", 11);
  y += 7 * MM;
  heading(x, y, "Konto / Zahlbar an");
  y = value(x, y + 8, [iban, ...addressLines(s.sender.address)]);
  y += 6;
  heading(x, y, "Referenz");
  y = value(x, y + 8, [`Rechnung ${inv.number}`]);
  y += 6;
  heading(x, y, "Zahlbar durch");
  y = value(x, y + 8, addressLines(s.recipient));
  y = top + 68 * MM;
  heading(x, y, "Währung");
  heading(x + 15 * MM, y, "Betrag");
  value(x, y + 8, ["CHF"]);
  value(x + 15 * MM, y + 8, [money2(inv.gross)]);
  heading(x + 38 * MM, top + 82 * MM, "Annahmestelle");

  // Payment part (right, 148 mm)
  x = 67 * MM;
  y = top + 5 * MM;
  title(x, y, "Zahlteil", 11);
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
  heading(x, y, "Währung", 8);
  heading(x + 20 * MM, y, "Betrag", 8);
  value(x, y + 10, ["CHF"], 10);
  value(x + 20 * MM, y + 10, [money2(inv.gross)], 10);

  x = 118 * MM;
  y = top + 5 * MM;
  heading(x, y, "Konto / Zahlbar an", 8);
  y = value(x, y + 10, [iban, ...addressLines(s.sender.address)], 10);
  y += 8;
  heading(x, y, "Referenz", 8);
  y = value(x, y + 10, [`Rechnung ${inv.number}`], 10);
  y += 8;
  heading(x, y, "Zusätzliche Informationen", 8);
  y = value(x, y + 10, [`${fmtMonthLong(inv.month)}, zahlbar bis ${swissDate(inv.dueDate)}`], 10);
  y += 8;
  heading(x, y, "Zahlbar durch", 8);
  value(x, y + 10, addressLines(s.recipient), 10);
  doc.restore();
}

export async function renderInvoicePdf(inv: Invoice): Promise<Buffer> {
  const s = inv.snapshot;
  const doc = new PDFDocument({ size: "A4", margins: { top: 50, bottom: 60, left: 50, right: 50 }, bufferPages: true, info: { Title: `Rechnung ${inv.number}`, Author: s.sender.address.name } });
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
    ["Rechnungsnummer", inv.number],
    ["Rechnungsdatum", swissDate(inv.issueDate)],
    ["Zahlbar bis", swissDate(inv.dueDate)],
    ["Leistungsperiode", fmtMonthLong(inv.month)],
  ];
  meta.forEach(([k, v], i) => {
    doc.fillColor(MUTED).text(k, 350, 130 + i * 13, { width: 100, lineBreak: false });
    doc.fillColor(INK).text(v, 450, 130 + i * 13, { width: 95, align: "right", lineBreak: false });
  });

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(14).text(`Rechnung ${inv.number}`, 50, 215);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`Leistungen und Spesen ${fmtMonthLong(inv.month)} für ${s.customerName}`, 50, 234);

  // Positions table
  const cols = [
    { label: "Beschreibung", w: W * 0.5 },
    { label: "Menge", w: W * 0.13, r: true },
    { label: "Ansatz", w: W * 0.17, r: true },
    { label: "Betrag CHF", w: W * 0.2, r: true },
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
    doc.text(`${qty(p.quantity)} ${p.unit}`, 50 + cols[0]!.w + 3, y + 3, { width: cols[1]!.w - 6, align: "right", lineBreak: false });
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
    ["Total netto", money2(inv.net), false],
    [`MwSt ${inv.vatRate.toLocaleString("de-CH")} %`, money2(inv.vat), false],
    ["Total CHF", money2(inv.gross), true],
  ];
  for (const [k, v, bold] of totals) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(INK);
    doc.text(k, 50 + W * 0.5, y, { width: W * 0.3 - 6, align: "right", lineBreak: false });
    doc.text(v, 50 + W * 0.8, y, { width: W * 0.2 - 3, align: "right", lineBreak: false });
    y += bold ? 18 : 14;
  }
  doc.moveTo(50 + W * 0.5, y - 4).lineTo(50 + W, y - 4).lineWidth(0.8).stroke(INK);
  y += 10;
  doc.font("Helvetica").fontSize(9).fillColor(INK).text(s.sender.footer || `Zahlbar innert ${s.sender.paymentDays} Tagen bis ${swissDate(inv.dueDate)} mit dem Zahlteil unten. Besten Dank für die Zusammenarbeit.`, 50, y, { width: W });

  // QR bill on the last page
  doc.switchToPage(doc.bufferedPageRange().count - 1);
  await drawQrBill(doc, inv);
  doc.end();
  return done;
}

export async function sendInvoice(ctx: AppContext, inv: Invoice, recipients: string[]) {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, inv.organizationId)).limit(1);
  if (!org) throw new HttpError(404, "Organisation nicht gefunden.");
  const pdf = await renderInvoicePdf(inv);
  const mail = actionMail(org.settings.branding, {
    to: recipients.join(", "),
    subject: `${org.name}: Rechnung ${inv.number} – ${fmtMonthLong(inv.month)}`,
    greeting: "Guten Tag",
    lines: [
      `Im Anhang finden Sie unsere Rechnung ${inv.number} für ${fmtMonthLong(inv.month)} über CHF ${money2(inv.gross)}.`,
      `Zahlbar bis ${swissDate(inv.dueDate)}; der Zahlteil mit QR-Code befindet sich auf der letzten Seite.`,
    ],
    footer: `Bei Fragen antworten Sie einfach auf diese E-Mail. Freundliche Grüsse, ${org.name}`,
  });
  await ctx.mailer.send({ ...mail, attachments: [{ filename: `Rechnung-${inv.number}.pdf`, content: pdf, contentType: "application/pdf" }] });
}

export const previousMonth = (today: string) => addMonths(today.slice(0, 7), -1);
