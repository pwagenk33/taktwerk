/** Scheduled digests: a weekly mail for project leads and a monthly mail for management, plain text lines in a branded mail. */
import { addMonths, countsExpense, fmtCHF, fmtDate, fmtMonthLong, isoWeekKey, monthOf, profitability, projectReports, utilization, weekRange } from "@taktwerk/domain";
import { and, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../app";
import { invoices, weekSubmissions, type OrgSettings } from "../db/schema";
import { actionMail, type Mail } from "../mail/mailer";
import { loadDataset } from "../routes/data";
import { tr } from "@taktwerk/domain";

export interface ScheduledReport {
  id: string;
  name: string;
  kind: "weekly" | "monthly";
  /** 1 = Monday … 7 = Sunday (weekly). */
  dayOfWeek?: number;
  /** 1–28 (monthly). */
  dayOfMonth?: number;
  /** Hour of the day, Zurich time. */
  hour: number;
  recipients: string[];
  enabled: boolean;
}

const h1 = (v: number) => v.toFixed(1).replace(".", ",");
const STATUS = { ok: "im Plan", risk: "knapp", over: "überschritten" } as const;
const adminView = (orgId: string) => ({ id: "", organizationId: orgId, name: "", username: "", email: "", role: "admin" as const });

/** Last week for project leads: hours per customer, projects at risk, approvals and missing week submissions. */
export async function weeklyDigest(ctx: AppContext, orgId: string, settings: OrgSettings, today: string): Promise<{ subject: string; lines: string[]; period: string }> {
  const data = await loadDataset(ctx, adminView(orgId));
  const last = new Date(`${today}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 7);
  const week = isoWeekKey(last.toISOString().slice(0, 10));
  const { from, to } = weekRange(week);
  const inWeek = data.timeEntries.filter((e) => e.date >= from && e.date <= to);
  const hours = inWeek.reduce((s, e) => s + e.hours, 0);
  const billable = inWeek.filter((e) => e.billable).reduce((s, e) => s + e.hours * e.hourlyRate, 0);
  const subToProject = new Map(data.subProjects.map((s) => [s.id, s.projectId]));
  const byProject = new Map<string, number>();
  for (const e of inWeek) byProject.set(subToProject.get(e.subProjectId) ?? "", (byProject.get(subToProject.get(e.subProjectId) ?? "") ?? 0) + e.hours);
  const reports = projectReports(data, { method: "rolling", window: 3 });
  const top = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([pid, h]) => {
    const r = reports.find((x) => x.project.id === pid);
    return `${r ? `${r.customer.name} · ${r.project.name}` : tr("Intern")}: ${h1(h)} h`;
  });
  const trouble = reports.filter((r) => r.status !== "ok").map((r) => tr("{0} · {1}: {2} (Forecast {3} bei Budget {4})", r.customer.name, r.project.name, tr(STATUS[r.status]), fmtCHF(r.forecastCost), fmtCHF(r.budget)));
  const openExpenses = data.expenses.filter((x) => x.status === "requested").length;
  const openAbsences = (data.absences ?? []).filter((a) => a.status === "requested").length;
  const subs = await ctx.db.select().from(weekSubmissions).where(and(eq(weekSubmissions.organizationId, orgId), eq(weekSubmissions.week, week)));
  const submitted = new Set(subs.map((s) => s.userId));
  const missing = data.employees.filter((e) => !submitted.has(e.id)).map((e) => e.name);
  const lines = [
    tr("Woche {0} ({1} bis {2}): {3} Stunden gebucht, davon verrechenbar {4}.", week.split("-W")[1], fmtDate(from), fmtDate(to), h1(hours), fmtCHF(billable)),
    ...(top.length ? [tr("Stunden pro Projekt:"), ...top.map((t) => `• ${t}`)] : []),
    trouble.length ? tr("Projekte mit Risiko:") : tr("Alle Projekte sind im Plan."),
    ...trouble.map((t) => `• ${t}`),
    tr("Offen zur Freigabe: {0} Spesen, {1} Absenzen.", openExpenses, openAbsences),
    missing.length ? tr("Woche noch nicht eingereicht: {0}.", missing.join(", ")) : tr("Alle haben die Woche eingereicht."),
  ];
  return { subject: tr("{0}: Wochenbericht KW {1}", settings.branding.appName, Number(week.split("-W")[1])), lines, period: week };
}

/** Last month for management: revenue, hours, utilization, margin, top customers, open invoices. */
export async function monthlyDigest(ctx: AppContext, orgId: string, settings: OrgSettings, today: string): Promise<{ subject: string; lines: string[]; period: string }> {
  const data = await loadDataset(ctx, adminView(orgId));
  const month = addMonths(monthOf(today), -1);
  const inMonth = data.timeEntries.filter((e) => monthOf(e.date) === month);
  const hours = inMonth.reduce((s, e) => s + e.hours, 0);
  const billable = inMonth.filter((e) => e.billable).reduce((s, e) => s + e.hours * e.hourlyRate, 0);
  const expenses = data.expenses.filter((x) => monthOf(x.date) === month && countsExpense(x)).reduce((s, x) => s + x.amount, 0);
  const util = utilization(data, month);
  const due = util.reduce((s, u) => s + u.due, 0);
  const bill = util.reduce((s, u) => s + u.billable, 0);
  const reports = projectReports(data, { method: "rolling", window: 3 });
  const profit = profitability(data, reports, month);
  const cust = new Map<string, number>();
  const subToCustomer = new Map(data.subProjects.map((s) => [s.id, data.projects.find((p) => p.id === s.projectId)?.customerId ?? ""]));
  for (const e of inMonth) if (e.billable) cust.set(subToCustomer.get(e.subProjectId) ?? "", (cust.get(subToCustomer.get(e.subProjectId) ?? "") ?? 0) + e.hours * e.hourlyRate);
  const top = [...cust.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cid, v]) => `• ${data.customers.find((c) => c.id === cid)?.name ?? tr("Intern")}: ${fmtCHF(v)}`);
  const open = await ctx.db.select().from(invoices).where(and(eq(invoices.organizationId, orgId), inArray(invoices.status, ["sent"])));
  const openSum = open.reduce((s, i) => s + i.gross, 0);
  const overdue = open.filter((i) => i.dueDate < today).length;
  const trouble = reports.filter((r) => r.status !== "ok").length;
  const lines = [
    tr("{0}: {1} Stunden, verrechenbar {2} plus Spesen {3}.", fmtMonthLong(month), h1(hours), fmtCHF(billable), fmtCHF(expenses)),
    `Auslastung: ${due > 0 ? Math.round((bill / due) * 100) : 0} % der Sollzeit verrechenbar (${h1(bill)} von ${h1(due)} h).`,
    tr("Marge im Monat: {0}{1} bei Kosten von {2}.", fmtCHF(profit.total.margin), profit.total.marginPct !== null ? ` (${Math.round(profit.total.marginPct * 100)} %)` : "", fmtCHF(profit.total.cost)),
    ...(top.length ? [tr("Top-Kunden nach Umsatz:"), ...top] : []),
    `Projekte: ${reports.length - trouble} im Plan, ${trouble} mit Risiko oder Überschreitung.`,
    tr("Offene Rechnungen: {0} über {1}{2}.", open.length, fmtCHF(openSum), overdue ? `, davon ${overdue} überfällig` : ""),
  ];
  return { subject: tr("{0}: Monatsbericht {1}", settings.branding.appName, fmtMonthLong(month)), lines, period: month };
}

export async function digestMail(ctx: AppContext, orgId: string, settings: OrgSettings, report: ScheduledReport, today: string): Promise<{ mail: Omit<Mail, "to">; period: string }> {
  const d = report.kind === "weekly" ? await weeklyDigest(ctx, orgId, settings, today) : await monthlyDigest(ctx, orgId, settings, today);
  const url = new URL(report.kind === "weekly" ? "/#projekte" : "/#reports", ctx.config.APP_URL).toString();
  const { to: _to, ...mail } = actionMail(settings.branding, {
    to: "",
    subject: d.subject,
    greeting: tr("Guten Tag"),
    lines: d.lines,
    action: report.kind === "weekly" ? tr("Projekte öffnen") : tr("Kundenreport öffnen"),
    url,
    footer: tr("Dieser Bericht «{0}» ist unter Einstellungen → Berichte & Export eingerichtet.", report.name),
  });
  return { mail, period: d.period };
}


