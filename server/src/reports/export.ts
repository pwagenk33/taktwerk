import { countsExpense, fmtCHF, fmtMonthLong, projectReports, type BudgetStatus, type Dataset, type Figures, type ProjectReport } from "@taktwerk/domain";
import { and, eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { HttpError, type AppContext } from "../app";
import { customers, organizations, type Branding } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { loadDataset } from "../routes/data";
import { tr } from "@taktwerk/domain";
import { currentLocale, withLocale } from "../i18n";

const STATUS_LABEL: Record<BudgetStatus, string> = { ok: tr("Im Plan"), risk: tr("Knapp"), over: tr("Überschreitung") };
// Traffic-light colours stay independent of the brand colour (see KONZEPT §9).
const STATUS_COLOR: Record<BudgetStatus, string> = { ok: "#1E7B4A", risk: "#B26A00", over: "#B3261E" };

const swissDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const hours = (v: number) => v.toLocaleString(`${currentLocale()}-CH`, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money2 = (v: number) => v.toLocaleString(`${currentLocale()}-CH`, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fileSafe = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

interface EntryLine {
  date: string;
  person: string;
  project: string;
  subProject: string;
  issue: string;
  reason: string;
  hours: number;
  rate: number;
  amount: number;
}

interface ExpenseLine {
  date: string;
  person: string;
  project: string;
  subProject: string;
  category: string;
  reason: string;
  amount: number;
}

export interface CustomerReport {
  /** Language of the customer: texts, numbers and dates of PDF, Excel and mail. */
  locale: string;
  orgName: string;
  branding: Branding;
  customerName: string;
  month: string;
  today: string;
  projects: ProjectReport[];
  totals: Pick<Figures, "budget" | "actualCost" | "remainingBudget" | "forecastCost" | "variance" | "status">;
  entries: EntryLine[];
  expenses: ExpenseLine[];
}

/** Everything a customer report shows: budget/forecast as of today plus the billable bookings of `month`. */
export async function customerReport(ctx: AppContext, orgId: string, customerId: string, month: string): Promise<CustomerReport> {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const [customer] = await ctx.db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, orgId))).limit(1);
  if (!org || !customer) throw new HttpError(404, tr("Kunde nicht gefunden."));

  // Reports are an organization-wide view; load the data with admin visibility.
  const data: Dataset = await loadDataset(ctx, { id: "", organizationId: orgId, name: "", username: "", email: "", role: "admin" });
  const projects = projectReports(data, { method: "rolling", window: 3 }, customerId);
  const sum = (k: "budget" | "actualCost" | "forecastCost") => projects.reduce((s, p) => s + p[k], 0);
  const budget = sum("budget");
  const forecastCost = sum("forecastCost");
  const actualCost = sum("actualCost");

  const subInfo = new Map(projects.flatMap((p) => p.subs.map((s) => [s.subProject.id, { project: p.project.name, subProject: s.subProject.name }] as const)));
  const person = new Map(data.employees.map((e) => [e.id, e.name]));
  const inMonth = (d: string) => d.startsWith(month);

  const entries = data.timeEntries
    .filter((e) => e.billable && inMonth(e.date) && subInfo.has(e.subProjectId))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({
      date: e.date,
      person: person.get(e.employeeId) ?? "–",
      ...subInfo.get(e.subProjectId)!,
      issue: e.jiraIssueKey ?? "",
      reason: e.reason,
      hours: e.hours,
      rate: e.hourlyRate,
      amount: Math.round(e.hours * e.hourlyRate * 100) / 100,
    }));
  const expenses = data.expenses
    .filter((x) => countsExpense(x) && inMonth(x.date) && subInfo.has(x.subProjectId))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((x) => ({ date: x.date, person: person.get(x.employeeId) ?? "–", ...subInfo.get(x.subProjectId)!, category: x.category, reason: x.reason, amount: x.amount }));

  return {
    locale: customer.locale,
    orgName: org.name,
    branding: org.settings.branding,
    customerName: customer.name,
    month,
    today: data.today,
    projects,
    totals: {
      budget,
      actualCost,
      remainingBudget: budget - actualCost,
      forecastCost,
      variance: budget - forecastCost,
      status: projects.some((p) => p.status === "over") ? "over" : projects.some((p) => p.status === "risk") ? "risk" : "ok",
    },
    entries,
    expenses,
  };
}

// ---------- PDF ----------

const A4 = { w: 595.28, h: 841.89 };
const M = 40;
const INK = "#1D1D1F";
const MUTED = "#6E6E73";
const LINE = "#E3E3E6";

interface Col {
  label: string;
  width: number;
  align?: "left" | "right";
}

export function renderPdf(r: CustomerReport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: M, bottom: M + 20, left: M, right: M },
    bufferPages: true,
    info: { Title: tr("Kundenreport {0} {1}", r.customerName, fmtMonthLong(r.month)), Author: r.orgName, Creator: r.branding.appName },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const brand = r.branding.primaryColor;
  const contentW = A4.w - 2 * M;
  const bottom = A4.h - M - 20;

  // Header band
  doc.rect(0, 0, A4.w, 64).fill(brand);
  if (r.branding.showMotif) {
    // Small Matterhorn mark, same silhouette idea as the web app.
    doc.save().translate(M, 18).scale(0.9);
    doc.polygon([0, 28], [12, 10], [17, 14], [24, 0], [30, 9], [34, 6], [46, 28]).fill("#FFFFFF");
    doc.restore();
  }
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(18).text(r.branding.appName, M + (r.branding.showMotif ? 52 : 0), 22, { lineBreak: false });
  doc.font("Helvetica").fontSize(10).text(tr("Kundenreport"), M, 27, { width: contentW, align: "right" });

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(r.customerName, M, 88);
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(tr("Leistungsnachweis {0} · Budget und Forecast per {1} · {2}", fmtMonthLong(r.month), swissDate(r.today), r.orgName));

  // Summary tiles
  const tiles: [string, string, string?][] = [
    [tr("Gesamtbudget"), fmtCHF(r.totals.budget)],
    [tr("Verbraucht"), fmtCHF(r.totals.actualCost)],
    [tr("Verbleibend"), fmtCHF(r.totals.remainingBudget)],
    [tr("Forecast"), fmtCHF(r.totals.forecastCost)],
    [tr("Abweichung"), fmtCHF(r.totals.variance), r.totals.variance < 0 ? STATUS_COLOR.over : STATUS_COLOR.ok],
  ];
  const gap = 8;
  const tw = (contentW - gap * (tiles.length - 1)) / tiles.length;
  const ty = 136;
  tiles.forEach(([label, value, color], i) => {
    const x = M + i * (tw + gap);
    doc.roundedRect(x, ty, tw, 50, 4).lineWidth(0.8).stroke(LINE);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label.toUpperCase(), x + 8, ty + 9, { width: tw - 16, lineBreak: false });
    doc.fillColor(color ?? INK).font("Helvetica-Bold").fontSize(12).text(value, x + 8, ty + 24, { width: tw - 16, lineBreak: false });
  });
  doc.y = ty + 70;

  const heading = (text: string) => {
    if (doc.y > bottom - 60) doc.addPage();
    doc.x = M;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(text, M, doc.y);
    doc.moveDown(0.4);
  };

  const table = (cols: Col[], rows: { cells: string[]; bold?: boolean; color?: (i: number) => string | undefined; fill?: string }[]) => {
    const pad = 4;
    const headerRow = () => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
      let x = M;
      for (const c of cols) {
        doc.text(c.label, x + pad, y + 4, { width: c.width - 2 * pad, align: c.align ?? "left", lineBreak: false });
        x += c.width;
      }
      doc.moveTo(M, y + 17).lineTo(M + contentW, y + 17).lineWidth(0.8).stroke(INK);
      doc.y = y + 19;
    };
    headerRow();
    for (const row of rows) {
      doc.font(row.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
      const h = Math.max(...row.cells.map((t, i) => doc.heightOfString(t, { width: cols[i]!.width - 2 * pad }))) + 8;
      if (doc.y + h > bottom) {
        doc.addPage();
        doc.y = M;
        headerRow();
        doc.font(row.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
      }
      const y = doc.y;
      if (row.fill) doc.rect(M, y, contentW, h).fill(row.fill);
      let x = M;
      row.cells.forEach((t, i) => {
        doc.fillColor(row.color?.(i) ?? INK).text(t, x + pad, y + 4, { width: cols[i]!.width - 2 * pad, align: cols[i]!.align ?? "left" });
        x += cols[i]!.width;
      });
      doc.moveTo(M, y + h).lineTo(M + contentW, y + h).lineWidth(0.4).stroke(LINE);
      doc.y = y + h;
    }
    doc.x = M;
    doc.moveDown(1.2);
  };

  // Budget and forecast per project and sub-project
  heading(tr("Budget und Forecast"));
  const w = contentW;
  const figCols: Col[] = [
    { label: tr("Projekt / Subprojekt"), width: w * 0.28 },
    { label: tr("Budget"), width: w * 0.12, align: "right" },
    { label: tr("Verbraucht"), width: w * 0.12, align: "right" },
    { label: tr("Verbleibend"), width: w * 0.12, align: "right" },
    { label: tr("Forecast"), width: w * 0.12, align: "right" },
    { label: tr("Abweichung"), width: w * 0.12, align: "right" },
    { label: tr("Status"), width: w * 0.12 },
  ];
  const figRow = (name: string, f: Figures, bold: boolean, fill?: string) => ({
    cells: [name, fmtCHF(f.budget), fmtCHF(f.actualCost), fmtCHF(f.remainingBudget), fmtCHF(f.forecastCost), fmtCHF(f.variance), STATUS_LABEL[f.status]],
    bold,
    fill,
    color: (i: number) => (i === 6 ? STATUS_COLOR[f.status] : i === 5 && f.variance < 0 ? STATUS_COLOR.over : undefined),
  });
  table(
    figCols,
    r.projects.flatMap((p) => [figRow(p.project.name, p, true, "#F6F6F7"), ...p.subs.map((s) => figRow(`   ${s.subProject.name}`, s, false))]),
  );
  doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(
    tr("Forecast = verbrauchte Kosten + offene Story Points × aktuelle Team-Velocity (Stunden pro Story Point, gleitender Schnitt 3 Monate) × aktueller Stundensatz. Projektbudgets können eine Reserve über den Subprojekten enthalten."),
    M,
    doc.y - 8,
    { width: contentW },
  );
  doc.moveDown(1.2);

  // Services of the month
  heading(tr("Leistungen {0}", fmtMonthLong(r.month)));
  if (r.entries.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(tr("Keine verrechenbaren Leistungen in diesem Monat."), M);
    doc.moveDown(1.2);
  } else {
    const totalH = r.entries.reduce((s, e) => s + e.hours, 0);
    const totalA = r.entries.reduce((s, e) => s + e.amount, 0);
    table(
      [
        { label: tr("Datum"), width: w * 0.1 },
        { label: tr("Person"), width: w * 0.14 },
        { label: tr("Subprojekt"), width: w * 0.18 },
        { label: tr("Grund"), width: w * 0.34 },
        { label: tr("Std."), width: w * 0.09, align: "right" },
        { label: tr("Betrag CHF"), width: w * 0.15, align: "right" },
      ],
      [
        ...r.entries.map((e) => ({ cells: [swissDate(e.date), e.person, e.subProject, e.issue && !e.reason.startsWith(e.issue) ? `${e.issue} · ${e.reason}` : e.reason, hours(e.hours), money2(e.amount)] })),
        { cells: [tr("Total"), "", "", "", hours(totalH), money2(totalA)], bold: true, fill: "#F6F6F7" },
      ],
    );
  }

  heading(tr("Spesen {0}", fmtMonthLong(r.month)));
  if (r.expenses.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(tr("Keine verrechenbaren Spesen in diesem Monat."), M);
  } else {
    table(
      [
        { label: tr("Datum"), width: w * 0.1 },
        { label: tr("Person"), width: w * 0.14 },
        { label: tr("Subprojekt"), width: w * 0.18 },
        { label: tr("Kategorie"), width: w * 0.12 },
        { label: tr("Grund"), width: w * 0.31 },
        { label: tr("Betrag CHF"), width: w * 0.15, align: "right" },
      ],
      [
        ...r.expenses.map((x) => ({ cells: [swissDate(x.date), x.person, x.subProject, x.category, x.reason, money2(x.amount)] })),
        { cells: [tr("Total"), "", "", "", "", money2(r.expenses.reduce((s, x) => s + x.amount, 0))], bold: true, fill: "#F6F6F7" },
      ],
    );
  }

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // footer sits below the content area; don't let it trigger a page break
    doc.moveTo(M, A4.h - M - 6).lineTo(A4.w - M, A4.h - M - 6).lineWidth(1.5).stroke(brand);
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    doc.text(`${r.orgName} · ${r.customerName} · ${fmtMonthLong(r.month)}`, M, A4.h - M, { width: contentW / 2, lineBreak: false });
    doc.text(tr("Seite {0} von {1}", i + 1, range.count), M + contentW / 2, A4.h - M, { width: contentW / 2, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}

// ---------- Excel ----------

export async function renderXlsx(r: CustomerReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = r.branding.appName;
  wb.created = new Date();
  const brandArgb = `FF${r.branding.primaryColor.replace("#", "").toUpperCase()}`;
  const chf = '#,##0.00 "CHF"';
  const styleHeader = (row: ExcelJS.Row) => {
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: brandArgb } }));
  };

  const ov = wb.addWorksheet(tr("Übersicht"), { views: [{ state: "frozen", ySplit: 6 }] });
  ov.columns = [{ width: 36 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 10 }, { width: 10 }, { width: 16 }];
  ov.addRow([tr("Kundenreport {0}", r.customerName)]).font = { bold: true, size: 14 };
  ov.addRow([tr("Leistungsnachweis {0}", fmtMonthLong(r.month))]);
  ov.addRow([tr("Budget und Forecast per {0}", swissDate(r.today))]);
  ov.addRow([r.orgName]);
  ov.addRow([]);
  styleHeader(ov.addRow([tr("Projekt / Subprojekt"), tr("Budget"), tr("Verbraucht"), tr("Verbleibend"), tr("Forecast"), tr("Abweichung"), tr("SP offen"), tr("SP erledigt"), tr("Status")]));
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const fig = (name: string, f: Figures) => [name, r2(f.budget), r2(f.actualCost), r2(f.remainingBudget), r2(f.forecastCost), r2(f.variance), f.spOpen, f.spDone, STATUS_LABEL[f.status]];
  for (const p of r.projects) {
    ov.addRow(fig(p.project.name, p)).font = { bold: true };
    for (const s of p.subs) ov.addRow(fig(`   ${s.subProject.name}`, s));
  }
  const tt = r.totals;
  const t = ov.addRow([tr("Total"), r2(tt.budget), r2(tt.actualCost), r2(tt.remainingBudget), r2(tt.forecastCost), r2(tt.variance), null, null, STATUS_LABEL[tt.status]]);
  t.font = { bold: true };
  t.border = { top: { style: "thin" } };
  for (const c of [2, 3, 4, 5, 6]) ov.getColumn(c).numFmt = chf;

  const le = wb.addWorksheet(tr("Leistungen"), { views: [{ state: "frozen", ySplit: 1 }] });
  le.columns = [
    { header: tr("Datum"), key: "date", width: 12 },
    { header: tr("Person"), key: "person", width: 20 },
    { header: tr("Projekt"), key: "project", width: 24 },
    { header: tr("Subprojekt"), key: "subProject", width: 24 },
    { header: "JIRA-Issue", key: "issue", width: 12 },
    { header: tr("Grund"), key: "reason", width: 48 },
    { header: tr("Stunden"), key: "hours", width: 10, style: { numFmt: "0.00" } },
    { header: tr("Satz"), key: "rate", width: 12, style: { numFmt: chf } },
    { header: tr("Betrag"), key: "amount", width: 14, style: { numFmt: chf } },
  ];
  styleHeader(le.getRow(1));
  for (const e of r.entries) le.addRow({ ...e, date: new Date(`${e.date}T00:00:00Z`) });
  le.getColumn("date").numFmt = "dd.mm.yyyy";
  if (r.entries.length) {
    const last = r.entries.length + 1;
    const totalRow = le.addRow({ date: tr("Total"), hours: { formula: `SUM(G2:G${last})` }, amount: { formula: `SUM(I2:I${last})` } });
    totalRow.font = { bold: true };
  }

  const sp = wb.addWorksheet(tr("Spesen"), { views: [{ state: "frozen", ySplit: 1 }] });
  sp.columns = [
    { header: tr("Datum"), key: "date", width: 12 },
    { header: tr("Person"), key: "person", width: 20 },
    { header: tr("Projekt"), key: "project", width: 24 },
    { header: tr("Subprojekt"), key: "subProject", width: 24 },
    { header: tr("Kategorie"), key: "category", width: 14 },
    { header: tr("Grund"), key: "reason", width: 48 },
    { header: tr("Betrag"), key: "amount", width: 14, style: { numFmt: chf } },
  ];
  styleHeader(sp.getRow(1));
  for (const x of r.expenses) sp.addRow({ ...x, date: new Date(`${x.date}T00:00:00Z`) });
  sp.getColumn("date").numFmt = "dd.mm.yyyy";
  if (r.expenses.length) {
    const totalRow = sp.addRow({ date: tr("Total"), amount: { formula: `SUM(G2:G${r.expenses.length + 1})` } });
    totalRow.font = { bold: true };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- files and mail ----------

const CONTENT_TYPE = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

const filename = (r: CustomerReport, ext: string) => tr("Report-{0}-{1}.{2}", fileSafe(r.customerName), r.month, ext);

export async function reportFile(ctx: AppContext, orgId: string, customerId: string, month: string, format: "pdf" | "xlsx") {
  const r = await customerReport(ctx, orgId, customerId, month);
  return withLocale(r.locale, async () => {
    const data = format === "pdf" ? await renderPdf(r) : await renderXlsx(r);
    return { contentType: CONTENT_TYPE[format], filename: filename(r, format), data };
  });
}

/** Mails PDF and Excel to the customer's report recipients. Returns the addresses (empty: nothing sent). */
export async function sendCustomerReport(ctx: AppContext, orgId: string, customerId: string, month: string): Promise<string[]> {
  const [customer] = await ctx.db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, orgId))).limit(1);
  if (!customer) throw new HttpError(404, tr("Kunde nicht gefunden."));
  const recipients = customer.reportRecipients;
  if (recipients.length === 0) return [];
  return withLocale(customer.locale, () => mailCustomerReport(ctx, orgId, customerId, month, recipients));
}

async function mailCustomerReport(ctx: AppContext, orgId: string, customerId: string, month: string, recipients: string[]): Promise<string[]> {
  const r = await customerReport(ctx, orgId, customerId, month);
  const [pdf, xlsx] = await Promise.all([renderPdf(r), renderXlsx(r)]);
  const hoursTotal = r.entries.reduce((s, e) => s + e.hours, 0);
  const mail = actionMail(r.branding, {
    to: recipients.join(", "),
    subject: tr("{0}: Report {1} – {2}", r.orgName, fmtMonthLong(r.month), r.customerName),
    greeting: tr("Guten Tag"),
    lines: [
      tr("Im Anhang finden Sie den Report für {0} als PDF und Excel.", fmtMonthLong(r.month)),
      tr("Leistungen im {0}: {1} Stunden. Budget gesamt {2}, verbraucht {3}, Forecast {4}.", fmtMonthLong(r.month), hours(hoursTotal), fmtCHF(r.totals.budget), fmtCHF(r.totals.actualCost), fmtCHF(r.totals.forecastCost)),
    ],
    footer: tr("Bei Fragen antworten Sie einfach auf diese E-Mail. Freundliche Grüsse, {0}", r.orgName),
  });
  await ctx.mailer.send({
    ...mail,
    attachments: [
      { filename: filename(r, "pdf"), content: pdf, contentType: CONTENT_TYPE.pdf },
      { filename: filename(r, "xlsx"), content: xlsx, contentType: CONTENT_TYPE.xlsx },
    ],
  });
  return recipients;
}
