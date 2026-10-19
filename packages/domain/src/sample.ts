// Deterministic example data: 4 customers, 11 months of history, team velocity drifting from 3.5 to 6.5 h/SP.
import { addMonths, monthOf, monthRange, projectReports, rateOn } from "./calc";
import { WorkCalendar, addDays, defaultHolidays } from "./worktime";
import type {
  Absence,
  Customer,
  Dataset,
  Employee,
  Expense,
  ExpenseCategory,
  JiraIssue,
  Project,
  SubProject,
  TimeEntry,
  WorkModel,
} from "./types";

export const TODAY = "2026-10-18";
const FIRST_MONTH = "2025-11";

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRACKING_START = "2026-01-01";
const employees: Employee[] = [
  { id: "e1", name: "Anna Keller", initials: "AK", role: "admin", teamId: "t1", workload: 100, vacationDays: 25, vacationCarry: 3, costRate: 125 },
  { id: "e2", name: "Marco Brunner", initials: "MB", role: "consultant", teamId: "t1", workload: 100, vacationDays: 25, overtimeCarry: 12.5, costRate: 115 },
  { id: "e3", name: "Lea Meier", initials: "LM", role: "employee", teamId: "t1", workload: 100, vacationDays: 25, overtimeCarry: -4, costRate: 92 },
  { id: "e4", name: "Jonas Weber", initials: "JW", role: "employee", teamId: "t1", workload: 80, vacationDays: 20, costRate: 88 },
  { id: "e5", name: "Sara Frei", initials: "SF", role: "employee", teamId: "t1", workload: 100, vacationDays: 25, vacationCarry: 2, costRate: 98 },
  { id: "e6", name: "Luca Schmid", initials: "LS", role: "employee", teamId: "t1", workload: 60, vacationDays: 15, costRate: 78 },
  { id: "e7", name: "Nina Huber", initials: "NH", role: "employee", teamId: "t1", workload: 80, vacationDays: 20, costRate: 85 },
].map((e) => ({ ...e, role: e.role as Employee["role"], trackingStart: TRACKING_START }));

/** Tendency to work more or less than the target, so the example shows different overtime balances. */
const DILIGENCE: Record<string, number> = { e1: 0.01, e2: 0.0, e3: -0.02, e4: -0.04, e5: 0.01, e6: -0.03, e7: -0.06 };

const absence = (id: string, employeeId: string, type: Absence["type"], startDate: string, endDate: string, status: Absence["status"] = "approved", halfDay = false, note?: string): Absence =>
  ({ id, employeeId, type, startDate, endDate, halfDay, status, note });

const ABSENCES: Absence[] = [
  absence("a1", "e1", "Ferien", "2026-07-20", "2026-07-31"),
  absence("a2", "e1", "Ferien", "2026-12-21", "2026-12-31", "requested", false, "Weihnachten mit Familie"),
  absence("a3", "e2", "Ferien", "2026-04-07", "2026-04-10"),
  absence("a4", "e2", "Ferien", "2026-08-10", "2026-08-21"),
  absence("a5", "e3", "Ferien", "2026-02-16", "2026-02-20"),
  absence("a6", "e3", "Krankheit", "2026-03-11", "2026-03-12"),
  absence("a7", "e3", "Ferien", "2026-07-06", "2026-07-17"),
  absence("a8", "e3", "Ferien", "2026-11-02", "2026-11-06", "requested", false, "Herbstferien"),
  absence("a9", "e4", "Militär/Zivildienst", "2026-03-02", "2026-03-13", "approved", false, "WK"),
  absence("a10", "e4", "Ferien", "2026-05-18", "2026-05-22"),
  absence("a11", "e5", "Weiterbildung", "2026-06-11", "2026-06-11", "approved", true, "Scrum-Master-Kurs"),
  absence("a12", "e5", "Ferien", "2026-10-05", "2026-10-09"),
  absence("a13", "e5", "Ferien", "2026-12-28", "2026-12-31", "requested"),
  absence("a14", "e6", "Ferien", "2026-08-03", "2026-08-14"),
  absence("a15", "e6", "Krankheit", "2026-10-14", "2026-10-15"),
  absence("a16", "e7", "Ferien", "2026-09-21", "2026-09-25"),
  absence("a17", "e7", "Kompensation", "2026-10-23", "2026-10-23", "requested", false, "Überzeit abbauen"),
];

const WORK_MODEL: WorkModel = {
  weeklyHours: 42,
  holidays: [2025, 2026, 2027].flatMap((y) => [
    ...defaultHolidays(y),
    { date: `${y}-12-24`, name: "Heiligabend (Nachmittag)", fraction: 0.5 },
    { date: `${y}-12-31`, name: "Silvester (Nachmittag)", fraction: 0.5 },
  ]).sort((a, b) => a.date.localeCompare(b.date)),
};

const INTERNAL_REASONS = ["Administration", "Team-Meeting", "Interne Weiterbildung", "Angebot erstellen", "Wissensaustausch", "Recruiting-Gespräch"];

const customers: Customer[] = [
  { id: "c1", name: "Alpenbank AG", rates: [{ validFrom: "2025-01-01", hourlyRate: 180 }, { validFrom: "2026-07-01", hourlyRate: 190 }],
    address: { name: "Alpenbank AG", street: "Bahnhofstrasse 12", zip: "8001", city: "Zürich", country: "CH" } },
  { id: "c2", name: "Rheinlogistik GmbH", rates: [{ validFrom: "2025-01-01", hourlyRate: 155 }],
    address: { name: "Rheinlogistik GmbH", street: "Hafenweg 3", zip: "4057", city: "Basel", country: "CH" } },
  { id: "c3", name: "Medtech Basel AG", currency: "EUR", rates: [{ validFrom: "2025-01-01", hourlyRate: 170 }],
    address: { name: "Medtech Basel AG", street: "Grenzacherstrasse 120", zip: "4058", city: "Basel", country: "CH" } },
  { id: "c4", name: "Stadtwerke Aarau", rates: [{ validFrom: "2025-01-01", hourlyRate: 145 }] },
  { id: "c5", name: "Intern", rates: [{ validFrom: "2025-01-01", hourlyRate: 0 }] },
];

const projects: Project[] = [
  { id: "p1", customerId: "c1", name: "Kundenportal Relaunch", budget: 0, jiraProjectKey: "KPR" },
  { id: "p2", customerId: "c2", name: "Flottenmanagement", budget: 0, jiraProjectKey: "FLT", kind: "retainer", retainerHours: 120 },
  { id: "p3", customerId: "c3", name: "QMS Digitalisierung", budget: 0, jiraProjectKey: "QMS" },
  { id: "p4", customerId: "c4", name: "Störungsmeldung App", budget: 0, jiraProjectKey: "SWA", kind: "fixed" },
  { id: "p5", customerId: "c5", name: "Interne Arbeit", budget: 0 },
];
const INTERNAL_SUB: SubProject = { id: "s11", projectId: "p5", name: "Administration & Weiterbildung", budget: 0 };

interface SubPlan {
  sub: SubProject;
  start: string;
  /** SP resolved per month while active. */
  pace: number;
  /** Open SP left in the backlog today. */
  backlog: number;
  /** Target forecast / budget ratio, so the example shows every status. */
  budgetRatio: number;
  summaries: string[];
}

const plans: SubPlan[] = [
  { sub: { id: "s1", projectId: "p1", name: "Login & Onboarding", budget: 0, jiraEpicKey: "KPR-1" }, start: "2025-11", pace: 14, backlog: 18, budgetRatio: 1.12,
    summaries: ["Passwort-Reset Flow", "2FA mit SMS-Code", "Onboarding-Wizard Schritt", "Session-Timeout", "Login-Fehlermeldungen", "SSO-Anbindung"] },
  { sub: { id: "s2", projectId: "p1", name: "Kontoübersicht", budget: 0, jiraEpicKey: "KPR-2" }, start: "2026-02", pace: 12, backlog: 46, budgetRatio: 0.97,
    summaries: ["Saldo-Widget", "Transaktionsliste filtern", "CSV-Export", "Kontodetails Ansicht", "Kategorisierung Buchungen"] },
  { sub: { id: "s3", projectId: "p1", name: "Zahlungsverkehr", budget: 0, jiraEpicKey: "KPR-3" }, start: "2026-05", pace: 9, backlog: 64, budgetRatio: 0.9,
    summaries: ["QR-Rechnung scannen", "Dauerauftrag erfassen", "eBill Integration", "Zahlungsfreigabe 4-Augen", "Limitenprüfung"] },
  { sub: { id: "s4", projectId: "p2", name: "Tracking-API", budget: 0, jiraEpicKey: "FLT-1" }, start: "2025-11", pace: 11, backlog: 8, budgetRatio: 1.18,
    summaries: ["GPS-Ingest Endpoint", "Webhook für Statuswechsel", "Rate Limiting", "API-Dokumentation", "Positionshistorie"] },
  { sub: { id: "s5", projectId: "p2", name: "Disponenten-App", budget: 0, jiraEpicKey: "FLT-2" }, start: "2026-01", pace: 10, backlog: 34, budgetRatio: 1.06,
    summaries: ["Tourenplanung Drag & Drop", "Fahrerzuweisung", "Kartenansicht Live", "Pausenregeln", "Push an Fahrer"] },
  { sub: { id: "s6", projectId: "p2", name: "Reporting", budget: 0, jiraEpicKey: "FLT-3" }, start: "2026-06", pace: 5, backlog: 20, budgetRatio: 0.94,
    summaries: ["Auslastungsbericht", "CO₂-Auswertung", "Kilometer pro Fahrzeug", "Export PDF"] },
  { sub: { id: "s7", projectId: "p3", name: "Dokumentenlenkung", budget: 0, jiraEpicKey: "QMS-1" }, start: "2025-12", pace: 8, backlog: 12, budgetRatio: 1.1,
    summaries: ["Freigabe-Workflow SOP", "Versionierung Dokumente", "Elektronische Signatur", "Lesebestätigung"] },
  { sub: { id: "s8", projectId: "p3", name: "Audit-Modul", budget: 0, jiraEpicKey: "QMS-2" }, start: "2026-04", pace: 7, backlog: 30, budgetRatio: 1.02,
    summaries: ["Auditplan erstellen", "Abweichungen erfassen", "CAPA-Massnahmen", "Audit-Trail Export"] },
  { sub: { id: "s9", projectId: "p4", name: "Bürger-App", budget: 0, jiraEpicKey: "SWA-1" }, start: "2026-03", pace: 6, backlog: 14, budgetRatio: 1.08,
    summaries: ["Störung mit Foto melden", "Standort auf Karte", "Status-Benachrichtigung", "Barrierefreiheit"] },
  { sub: { id: "s10", projectId: "p4", name: "Backoffice", budget: 0, jiraEpicKey: "SWA-2" }, start: "2026-04", pace: 4, backlog: 10, budgetRatio: 1.15,
    summaries: ["Meldungen triagieren", "Zuweisung an Werkdienst", "Statistik Störungen"] },
];

const OVERHEAD_REASONS = ["Sprint Planning", "Kunden-Meeting", "Code Review", "Projektleitung", "Daily & Refinement", "Abnahme mit Kunde"];
const EXPENSES: { category: ExpenseCategory; reason: string; amount: [number, number]; vatRate: number; km?: [number, number] }[] = [
  { category: "Reise", reason: "SBB Retourbillett zum Kunden", amount: [58, 96], vatRate: 8.1 },
  { category: "Kilometer", reason: "Fahrt zum Kunden (Auto)", amount: [0, 0], vatRate: 0, km: [24, 110] },
  { category: "Unterkunft", reason: "Hotel Workshop vor Ort", amount: [165, 240], vatRate: 3.8 },
  { category: "Verpflegung", reason: "Mittagessen Workshop", amount: [24, 62], vatRate: 8.1 },
  { category: "Lizenzen", reason: "Testgeräte-Cloud Monatslizenz", amount: [180, 320], vatRate: 8.1 },
];
export const SAMPLE_RATES = { kmRate: 0.7, vatRate: 8.1 };

/** Places each person's bookings of a day one after another from 08:00, with a lunch break from 12:00 to 13:00. */
function withStartTimes(entries: TimeEntry[]): TimeEntry[] {
  const byDay = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const k = `${e.employeeId}|${e.date}`;
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  for (const list of byDay.values()) {
    let min = 8 * 60;
    for (const e of list) {
      if (min < 12 * 60 && min + e.hours * 60 > 12 * 60) min = 13 * 60;
      e.startTime = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
      min += Math.round(e.hours * 4) * 15;
    }
  }
  return entries;
}

/** True team factor (h/SP) per month: 3.5 for three months, then drifting up to 6.5. */
function trueFactor(monthIndex: number): number {
  if (monthIndex <= 2) return 3.5;
  if (monthIndex >= 9) return 6.5;
  return 3.5 + ((monthIndex - 2) / 7) * 3;
}

function workdays(month: string, until: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) break;
    const iso = date.toISOString().slice(0, 10);
    const wd = date.getUTCDay();
    if (wd !== 0 && wd !== 6 && iso <= until) out.push(iso);
  }
  return out;
}

const nextDay = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

export function buildDataset(): Dataset {
  const rand = rng(20261018);
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const between = (a: number, b: number) => a + rand() * (b - a);
  const SIZES = [1, 2, 3, 3, 5, 5, 8];

  const timeEntries: TimeEntry[] = [];
  const expenses: Expense[] = [];
  const issues: JiraIssue[] = [];
  const current = monthOf(TODAY);
  const months = monthRange(FIRST_MONTH, current);
  let entrySeq = 0;
  const issueSeq = new Map<string, number>();

  const book = (sub: SubProject, date: string, hours: number, reason: string, issueKey?: string, employeeId?: string) => {
    const customer = customers.find((c) => c.id === projects.find((p) => p.id === sub.projectId)!.customerId)!;
    timeEntries.push({
      id: `t${++entrySeq}`,
      employeeId: employeeId ?? pick(employees.slice(1)).id,
      subProjectId: sub.id,
      date,
      hours: Math.round(hours * 4) / 4,
      reason,
      billable: true,
      hourlyRate: rateOn(customer, date),
      jiraIssueKey: issueKey,
    });
  };

  // Book an issue's hours in 1-6 h chunks on workdays of the given months.
  const bookIssue = (plan: SubPlan, issue: JiraIssue, hours: number, inMonths: string[]) => {
    const dev = pick(employees.slice(2)).id;
    let left = hours;
    while (left > 0.2) {
      const chunk = Math.min(left, Math.round(between(1, 6) * 4) / 4);
      const days = workdays(pick(inMonths), TODAY);
      if (days.length === 0) break;
      book(plan.sub, pick(days), chunk, `${issue.key} ${issue.summary}`, issue.key, rand() < 0.8 ? dev : undefined);
      left -= chunk;
    }
  };

  const newIssue = (plan: SubPlan, sp: number): JiraIssue => {
    const prefix = plan.sub.jiraEpicKey!.split("-")[0];
    const n = (issueSeq.get(prefix) ?? 100) + 1 + Math.floor(rand() * 3);
    issueSeq.set(prefix, n);
    return { key: `${prefix}-${n}`, summary: pick(plan.summaries), subProjectId: plan.sub.id, storyPoints: sp, status: "To Do" };
  };

  for (const plan of plans) {
    for (const [mi, month] of months.entries()) {
      if (month < plan.start) continue;
      const partial = month === current;
      const days = workdays(month, TODAY);
      let target = plan.pace * between(0.8, 1.2) * (partial ? 0.5 : 1);
      let issueHours = 0;
      while (target > 0.5) {
        const sp = pick(SIZES);
        const issue = newIssue(plan, sp);
        issue.status = "Done";
        const resolved = days[Math.min(days.length - 1, Math.floor(between(0.4, 1) * days.length))];
        issue.resolvedAt = resolved;
        const hours = sp * trueFactor(mi) * between(0.85, 1.15);
        // Most work lands in the month of resolution, some in the month before.
        const workMonths = month > plan.start && rand() < 0.3 ? [addMonths(month, -1), month] : [month];
        bookIssue(plan, issue, hours, workMonths);
        issues.push(issue);
        issueHours += hours;
        target -= sp;
      }
      // Overhead without JIRA issue, about 15 % of issue hours.
      let overhead = issueHours * between(0.1, 0.2);
      while (overhead > 0.5 && days.length) {
        const chunk = Math.min(overhead, pick([1, 1.5, 2, 2.5]));
        book(plan.sub, pick(days), chunk, pick(OVERHEAD_REASONS), undefined, pick(employees.slice(0, 2)).id);
        overhead -= chunk;
      }
      if (rand() < 0.55 && days.length) {
        const x = pick(EXPENSES);
        const who = pick(employees);
        const date = pick(days);
        const km = x.km ? Math.round(between(...x.km)) : undefined;
        const amount = km ? Math.round(km * SAMPLE_RATES.kmRate * 20) / 20 : Math.round(between(...x.amount) * 20) / 20;
        // Recent expenses of employees are still waiting for a lead's approval.
        const recent = date >= addDays(TODAY, -21);
        expenses.push({
          id: `x${expenses.length + 1}`,
          employeeId: who.id,
          subProjectId: plan.sub.id,
          date,
          amount,
          category: x.category,
          reason: x.reason,
          billable: true,
          vatRate: x.vatRate,
          km,
          status: who.role === "employee" && recent ? "requested" : "approved",
        });
      }
    }
    // Open backlog: a few issues in progress with partial hours, the rest to do.
    let backlog = plan.backlog;
    let inProgress = 0;
    while (backlog > 0) {
      const sp = Math.min(backlog, pick(SIZES));
      const issue = newIssue(plan, sp);
      if (inProgress < 2) {
        issue.status = "In Progress";
        bookIssue(plan, issue, sp * trueFactor(months.length - 1) * between(0.2, 0.5), [current]);
        inProgress++;
      }
      issues.push(issue);
      backlog -= sp;
    }
  }

  // Nobody books project work on a full day of approved absence.
  const away = (e: TimeEntry) =>
    ABSENCES.some((a) => a.status === "approved" && !a.halfDay && a.employeeId === e.employeeId && a.startDate <= e.date && a.endDate >= e.date);
  const draft: Dataset = {
    teams: [{ id: "t1", name: "Delivery Team" }],
    employees,
    customers,
    projects: projects.map((p) => ({ ...p })),
    subProjects: [...plans.map((p) => ({ ...p.sub })), { ...INTERNAL_SUB }],
    timeEntries: withStartTimes(timeEntries.filter((e) => !away(e))),
    expenses,
    issues,
    absences: ABSENCES.map((a) => ({ ...a })),
    workModel: WORK_MODEL,
    rates: SAMPLE_RATES,
    fx: { rates: { EUR: 0.94, USD: 0.8 }, asOf: TODAY, source: "Beispiel" },
    today: TODAY,
  };

  // Budgets are derived from the forecast so the example shows healthy, tight and overrun projects.
  const reports = projectReports(draft, { method: "rolling", window: 3 });
  for (const r of reports) {
    for (const s of r.subs) {
      const plan = plans.find((p) => p.sub.id === s.subProject.id);
      if (!plan) continue;
      draft.subProjects.find((x) => x.id === s.subProject.id)!.budget = Math.round((s.forecastCost * plan.budgetRatio) / 5000) * 5000;
    }
    const subTotal = draft.subProjects.filter((s) => s.projectId === r.project.id).reduce((a, s) => a + s.budget, 0);
    draft.projects.find((p) => p.id === r.project.id)!.budget = Math.round((subTotal * 1.04) / 5000) * 5000;
  }
  draft.projects.find((p) => p.id === "p5")!.budget = 0;

  // Spread project work over people with capacity that day, then fill each day up to roughly the target
  // with internal, non-billable time. Who booked does not change cost, velocity or forecast.
  const byDate = new Map<string, TimeEntry[]>();
  for (const e of draft.timeEntries) if (e.date >= TRACKING_START) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  const cals = new Map(employees.map((e) => [e.id, new WorkCalendar(draft, e)]));
  for (let d = TRACKING_START; d < TODAY; d = nextDay(d)) {
    const want = new Map(employees.map((e) => {
      const cal = cals.get(e.id)!;
      const due = cal.target(d) - cal.credit(d);
      return [e.id, due > 0 ? due * (1 + DILIGENCE[e.id]! + between(-0.12, 0.12)) : 0];
    }));
    const load = new Map(employees.map((e) => [e.id, 0]));
    for (const entry of (byDate.get(d) ?? []).sort((a, b) => b.hours - a.hours)) {
      const room = (id: string) => want.get(id)! - load.get(id)!;
      if (room(entry.employeeId) < entry.hours) {
        const best = employees.map((e) => e.id).filter((id) => id !== "e1" && want.get(id)! > 0).sort((a, b) => room(b) - room(a))[0];
        if (best && room(best) > room(entry.employeeId)) entry.employeeId = best;
      }
      load.set(entry.employeeId, load.get(entry.employeeId)! + entry.hours);
    }
    for (const emp of employees) {
      const gap = Math.round((want.get(emp.id)! - load.get(emp.id)!) * 4) / 4;
      if (gap < 0.25) continue;
      draft.timeEntries.push({
        id: `t${++entrySeq}`, employeeId: emp.id, subProjectId: INTERNAL_SUB.id, date: d, hours: gap,
        reason: pick(INTERNAL_REASONS), billable: false, hourlyRate: 0,
      });
    }
  }
  draft.timeEntries.sort((a, b) => a.date.localeCompare(b.date));
  return draft;
}
