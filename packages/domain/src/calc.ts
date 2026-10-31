import type {
  Currency,
  Customer,
  Dataset,
  Expense,
  FxRates,
  JiraIssue,
  Project,
  ProjectKind,
  SubProject,
  TimeEntry,
  VelocitySettings,
} from "./types";

// ---------- dates ----------

export const monthOf = (date: string) => date.slice(0, 7);

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

// ---------- rates ----------

/** Customer hourly rate valid on `date` (latest period starting on or before it). */
export const currencyOf = (customer: Pick<Customer, "currency"> | undefined) => customer?.currency ?? "CHF";

/** Converts an amount in `currency` to CHF with the dataset's rates; unknown rates count 1:1. */
export function toChf(amount: number, currency: Currency, fx?: FxRates): number {
  if (currency === "CHF") return amount;
  return amount * (fx?.rates[currency] ?? 1);
}

export function rateOn(customer: Customer, date: string): number {
  const sorted = [...customer.rates].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  let rate = sorted[0]?.hourlyRate ?? 0;
  for (const p of sorted) if (p.validFrom <= date) rate = p.hourlyRate;
  return rate;
}

// ---------- lookups ----------

export class Index {
  readonly sub = new Map<string, SubProject>();
  readonly project = new Map<string, Project>();
  readonly customer = new Map<string, Customer>();
  readonly issue = new Map<string, JiraIssue>();
  readonly entriesBySub = new Map<string, TimeEntry[]>();
  readonly hoursByIssue = new Map<string, number>();
  // Grouped once, so reports over hundreds of projects don't scan every list per sub-project.
  readonly subsByProject = new Map<string, SubProject[]>();
  readonly expensesBySub = new Map<string, Expense[]>();
  readonly issuesBySub = new Map<string, JiraIssue[]>();

  constructor(readonly data: Dataset) {
    const group = <T>(map: Map<string, T[]>, key: string | undefined, item: T) => {
      if (key === undefined) return;
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    };
    for (const s of data.subProjects) group(this.subsByProject, s.projectId, s);
    for (const x of data.expenses) group(this.expensesBySub, x.subProjectId, x);
    for (const i of data.issues) group(this.issuesBySub, i.subProjectId, i);
    data.subProjects.forEach((s) => this.sub.set(s.id, s));
    data.projects.forEach((p) => this.project.set(p.id, p));
    data.customers.forEach((c) => this.customer.set(c.id, c));
    data.issues.forEach((i) => this.issue.set(i.key, i));
    for (const e of data.timeEntries) {
      const list = this.entriesBySub.get(e.subProjectId) ?? [];
      list.push(e);
      this.entriesBySub.set(e.subProjectId, list);
      if (e.jiraIssueKey) this.hoursByIssue.set(e.jiraIssueKey, (this.hoursByIssue.get(e.jiraIssueKey) ?? 0) + e.hours);
    }
  }

  customerOfSub(subId: string): Customer {
    const sub = this.sub.get(subId)!;
    return this.customer.get(this.project.get(sub.projectId)!.customerId)!;
  }

  subsOf(projectId: string): SubProject[] {
    return this.subsByProject.get(projectId) ?? [];
  }
}

// ---------- velocity ----------

export interface VelocityMonth {
  month: string;
  /** Story points of issues resolved in this month. */
  storyPoints: number;
  /** All hours ever booked on the issues resolved in this month. */
  hours: number;
  /** hours / storyPoints for this month alone. */
  hoursPerSp: number | null;
  /** Smoothed factor (rolling window or EWMA) up to and including this month. */
  smoothed: number | null;
  /** Month still running; excluded from the "current" factor. */
  partial: boolean;
}

/**
 * Team velocity as "hours per story point", per month of resolution.
 * Rolling: sum(hours) / sum(SP) over the last N months (SP-weighted, robust against small months).
 * EWMA: exponentially weighted mean of the monthly factors, alpha = 2 / (N + 1).
 */
export function velocityByMonth(
  data: Dataset,
  settings: VelocitySettings,
  teamId?: string,
): VelocityMonth[] {
  const teamOf = new Map(data.employees.map((e) => [e.id, e.teamId]));
  const hoursByIssue = new Map<string, number>();
  for (const e of data.timeEntries) {
    if (!e.jiraIssueKey) continue;
    if (teamId && teamOf.get(e.employeeId) !== teamId) continue;
    hoursByIssue.set(e.jiraIssueKey, (hoursByIssue.get(e.jiraIssueKey) ?? 0) + e.hours);
  }

  const agg = new Map<string, { sp: number; h: number }>();
  for (const i of data.issues) {
    if (i.status !== "Done" || !i.resolvedAt || !hoursByIssue.has(i.key)) continue;
    const m = monthOf(i.resolvedAt);
    const a = agg.get(m) ?? { sp: 0, h: 0 };
    a.sp += i.storyPoints;
    a.h += hoursByIssue.get(i.key)!;
    agg.set(m, a);
  }
  if (agg.size === 0) return [];

  const current = monthOf(data.today);
  const first = [...agg.keys()].sort()[0];
  const months = monthRange(first, current);
  const alpha = 2 / (settings.window + 1);
  let ewma: number | null = null;

  return months.map((month, i) => {
    const a = agg.get(month) ?? { sp: 0, h: 0 };
    const factor = a.sp > 0 ? a.h / a.sp : null;
    let smoothed: number | null;
    if (settings.method === "rolling") {
      const win = months.slice(Math.max(0, i - settings.window + 1), i + 1).map((m) => agg.get(m) ?? { sp: 0, h: 0 });
      const sp = win.reduce((s, x) => s + x.sp, 0);
      smoothed = sp > 0 ? win.reduce((s, x) => s + x.h, 0) / sp : null;
    } else {
      if (factor !== null) ewma = ewma === null ? factor : alpha * factor + (1 - alpha) * ewma;
      smoothed = ewma;
    }
    return { month, storyPoints: a.sp, hours: a.h, hoursPerSp: factor, smoothed, partial: month === current };
  });
}

export interface VelocityFactor {
  /** Smoothed hours per SP at the last completed month: the forecast input. */
  current: number;
  /** Lowest / highest monthly factor inside the window: optimistic / pessimistic band. */
  low: number;
  high: number;
  asOf: string;
}

export function currentVelocity(months: VelocityMonth[], settings: VelocitySettings): VelocityFactor | null {
  const complete = months.filter((m) => !m.partial && m.smoothed !== null);
  const last = complete.at(-1);
  if (!last) return null;
  const window = complete.slice(-settings.window).map((m) => m.hoursPerSp).filter((x): x is number => x !== null);
  return {
    current: last.smoothed!,
    low: Math.min(...window),
    high: Math.max(...window),
    asOf: last.month,
  };
}

// ---------- budget & forecast ----------

export type BudgetStatus = "ok" | "risk" | "over";

export interface Figures {
  budget: number;
  hoursBooked: number;
  timeCost: number;
  expenseCost: number;
  actualCost: number;
  remainingBudget: number;
  spDone: number;
  spOpen: number;
  remainingHours: number;
  forecastCost: number;
  forecastLow: number;
  forecastHigh: number;
  /** budget - forecast; negative means overrun. */
  variance: number;
  status: BudgetStatus;
  /** Estimated month in which open SP are done, from recent throughput. */
  completionMonth: string | null;
}

export interface SubProjectReport extends Figures {
  subProject: SubProject;
}

export interface RetainerUsage {
  month: string;
  hoursPerMonth: number;
  /** Hours booked in the running month. */
  used: number;
  /** Average of the last three complete months. */
  avg3: number;
}

export interface ProjectReport extends Figures {
  project: Project;
  customer: Customer;
  subs: SubProjectReport[];
  kind: ProjectKind;
  currency: Currency;
  /** Only for retainer projects: usage of the monthly contingent. */
  retainer?: RetainerUsage;
}

/** Billable and approved (older expenses without status count as approved). */
export const countsExpense = (x: Expense) => x.billable && (x.status ?? "approved") === "approved";

export function statusFor(forecast: number, budget: number): BudgetStatus {
  if (budget <= 0) return "ok";
  if (forecast > budget) return "over";
  if (forecast > budget * 0.95) return "risk";
  return "ok";
}

/** Share of hours booked without a JIRA issue (meetings, PM, reviews) relative to issue hours. */
function overheadShare(entries: TimeEntry[]): number | null {
  const issueHours = entries.filter((e) => e.jiraIssueKey).reduce((s, e) => s + e.hours, 0);
  const other = entries.filter((e) => !e.jiraIssueKey).reduce((s, e) => s + e.hours, 0);
  if (issueHours + other < 40 || issueHours === 0) return null;
  return other / issueHours;
}

export function subProjectReport(
  idx: Index,
  sub: SubProject,
  velocity: VelocityFactor | null,
  globalOverhead: number,
): SubProjectReport {
  const data = idx.data;
  const entries = idx.entriesBySub.get(sub.id) ?? [];
  const expenses = (idx.expensesBySub.get(sub.id) ?? []).filter(countsExpense);
  const customer = idx.customerOfSub(sub.id);
  const rateNow = rateOn(customer, data.today);

  const hoursBooked = entries.reduce((s, e) => s + e.hours, 0);
  const timeCost = entries.filter((e) => e.billable).reduce((s, e) => s + e.hours * e.hourlyRate, 0);
  const expenseCost = expenses.reduce((s, x) => s + x.amount, 0);
  const actualCost = timeCost + expenseCost;

  const issues = idx.issuesBySub.get(sub.id) ?? [];
  const open = issues.filter((i) => i.status !== "Done");
  const spOpen = open.reduce((s, i) => s + i.storyPoints, 0);
  const spDone = issues.filter((i) => i.status === "Done").reduce((s, i) => s + i.storyPoints, 0);
  const bookedOnOpen = open.reduce((s, i) => s + (idx.hoursByIssue.get(i.key) ?? 0), 0);
  const overhead = 1 + (overheadShare(entries) ?? globalOverhead);

  // Hours still needed: open SP converted with the team factor, minus what is already booked on those issues.
  const rest = (factor: number) => Math.max(0, spOpen * factor - bookedOnOpen) * overhead;
  const remainingHours = velocity ? rest(velocity.current) : 0;
  const forecastCost = actualCost + remainingHours * rateNow;
  const forecastLow = velocity ? actualCost + rest(velocity.low) * rateNow : forecastCost;
  const forecastHigh = velocity ? actualCost + rest(velocity.high) * rateNow : forecastCost;

  // Throughput: SP resolved per month over the last three complete months.
  const current = monthOf(data.today);
  const recent = new Set([1, 2, 3].map((n) => addMonths(current, -n)));
  const recentSp = issues
    .filter((i) => i.resolvedAt && recent.has(monthOf(i.resolvedAt)))
    .reduce((s, i) => s + i.storyPoints, 0);
  const perMonth = recentSp / 3;
  const completionMonth =
    spOpen === 0 ? current : perMonth > 0 ? addMonths(current, Math.ceil(spOpen / perMonth) - 1) : null;

  return {
    subProject: sub,
    budget: sub.budget,
    hoursBooked,
    timeCost,
    expenseCost,
    actualCost,
    remainingBudget: sub.budget - actualCost,
    spDone,
    spOpen,
    remainingHours,
    forecastCost,
    forecastLow,
    forecastHigh,
    variance: sub.budget - forecastCost,
    status: statusFor(forecastCost, sub.budget),
    completionMonth,
  };
}

export function projectReports(data: Dataset, settings: VelocitySettings, customerId?: string): ProjectReport[] {
  const idx = new Index(data);
  const velocity = currentVelocity(velocityByMonth(data, settings), settings);
  // Team-wide overhead from JIRA-mapped sub-projects only, so internal time (admin, training) does not inflate it.
  const jiraSubs = new Set(data.subProjects.filter((s) => s.jiraEpicKey).map((s) => s.id));
  const globalOverhead = overheadShare(data.timeEntries.filter((e) => jiraSubs.has(e.subProjectId))) ?? 0.15;

  return data.projects
    .filter((p) => !customerId || p.customerId === customerId)
    .map((project) => {
      const subs = idx.subsOf(project.id).map((s) => subProjectReport(idx, s, velocity, globalOverhead));
      const sum = (k: keyof Figures) => subs.reduce((s, r) => s + (r[k] as number), 0);
      const forecastCost = sum("forecastCost");
      const actualCost = sum("actualCost");
      const months = subs.map((s) => s.completionMonth);
      const customer = idx.customer.get(project.customerId)!;
      const kind = project.kind ?? "tm";
      let retainer: RetainerUsage | undefined;
      let status = statusFor(forecastCost, project.budget);
      if (kind === "retainer" && project.retainerHours) {
        const current = monthOf(data.today);
        const subIds = new Set(subs.map((s) => s.subProject.id));
        const own = [...subIds].flatMap((id) => idx.entriesBySub.get(id) ?? []);
        const hoursIn = (m: string) => own.filter((e) => monthOf(e.date) === m).reduce((s, e) => s + e.hours, 0);
        const used = hoursIn(current);
        const avg3 = [1, 2, 3].reduce((s, n) => s + hoursIn(addMonths(current, -n)), 0) / 3;
        retainer = { month: current, hoursPerMonth: project.retainerHours, used, avg3 };
        status = statusFor(Math.max(used, avg3), project.retainerHours);
      }
      return {
        project,
        customer,
        subs,
        kind,
        currency: currencyOf(customer),
        retainer,
        budget: project.budget,
        hoursBooked: sum("hoursBooked"),
        timeCost: sum("timeCost"),
        expenseCost: sum("expenseCost"),
        actualCost,
        remainingBudget: project.budget - actualCost,
        spDone: sum("spDone"),
        spOpen: sum("spOpen"),
        remainingHours: sum("remainingHours"),
        forecastCost,
        forecastLow: sum("forecastLow"),
        forecastHigh: sum("forecastHigh"),
        variance: project.budget - forecastCost,
        status,
        completionMonth: months.includes(null) ? null : (months as string[]).sort().at(-1) ?? null,
      };
    });
}

export interface BurnPoint {
  month: string;
  actual: number | null;
  forecast: number | null;
  budget: number;
}

/** Cumulative cost per month, continued linearly to the forecast at the completion month. */
export function burnUp(data: Dataset, report: ProjectReport): BurnPoint[] {
  const subIds = new Set(report.subs.map((s) => s.subProject.id));
  const byMonth = new Map<string, number>();
  for (const e of data.timeEntries) {
    if (!subIds.has(e.subProjectId) || !e.billable) continue;
    byMonth.set(monthOf(e.date), (byMonth.get(monthOf(e.date)) ?? 0) + e.hours * e.hourlyRate);
  }
  for (const x of data.expenses.filter(countsExpense)) {
    if (!subIds.has(x.subProjectId)) continue;
    byMonth.set(monthOf(x.date), (byMonth.get(monthOf(x.date)) ?? 0) + x.amount);
  }
  if (byMonth.size === 0) return [];
  const current = monthOf(data.today);
  const end = report.completionMonth && report.completionMonth > current ? report.completionMonth : addMonths(current, 2);
  const months = monthRange([...byMonth.keys()].sort()[0], end);
  const futureSteps = months.filter((m) => m > current).length;
  let cum = 0;
  let step = 0;
  return months.map((month) => {
    if (month <= current) {
      cum += byMonth.get(month) ?? 0;
      return { month, actual: cum, forecast: month === current ? cum : null, budget: report.budget };
    }
    step += 1;
    const forecast = report.actualCost + ((report.forecastCost - report.actualCost) * step) / futureSteps;
    return { month, actual: null, forecast, budget: report.budget };
  });
}

// ---------- formatting (de-CH by default; fr-CH or en-CH per browser or per server request) ----------

let resolveTag: () => string = () => "de-CH";
/** Fixed language for all fmt* helpers ("de-CH", "fr-CH", "en-CH"); the browser sets it once at start. */
export function setFormatLocale(tag: string) { resolveTag = () => tag; }
/** The server decides per request (or per recipient of an e-mail). */
export function setFormatLocaleResolver(fn: () => string) { resolveTag = fn; }
export const formatLocale = () => resolveTag();
const formats = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
function nf(key: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const tag = resolveTag();
  let f = formats.get(`${tag}|${key}`);
  if (!f) formats.set(`${tag}|${key}`, (f = new Intl.NumberFormat(tag, opts)));
  return f as Intl.NumberFormat;
}
function df(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const tag = resolveTag();
  let f = formats.get(`${tag}|${key}`);
  if (!f) formats.set(`${tag}|${key}`, (f = new Intl.DateTimeFormat(tag, opts)));
  return f as Intl.DateTimeFormat;
}
const chf = { format: (v: number) => nf("chf", { style: "currency", currency: "CHF", maximumFractionDigits: 0 }).format(v) };
const chf2 = { format: (v: number) => nf("chf2", { style: "currency", currency: "CHF", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v) };
const num1 = { format: (v: number) => nf("num1", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(v) };
const num0 = { format: (v: number) => nf("num0", { maximumFractionDigits: 0 }).format(v) };
const monthFmt = { format: (d: Date) => df("month", { month: "short", year: "2-digit", timeZone: "UTC" }).format(d) };
const monthLong = { format: (d: Date) => df("monthLong", { month: "long", year: "numeric", timeZone: "UTC" }).format(d) };
const dayFmt = { format: (d: Date) => df("day", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(d) };

export const fmtCHF = (v: number) => chf.format(v);
/** Whole amounts in the given currency (CHF 12’300, € 9’800, $ 4’100). */
export function fmtMoney(v: number, currency: Currency = "CHF", fraction = 0): string {
  return nf(`${currency}:${fraction}`, { style: "currency", currency, minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(v);
}
/** Amounts where the Rappen matter (expenses, invoices, rates per km). */
export const fmtCHF2 = (v: number) => chf2.format(v);
export const fmtKCHF = (v: number) => `${num0.format(v / 1000)}k`;
export const fmtH = (v: number) => `${num1.format(v)} h`;
export const fmtNum = (v: number) => num0.format(v);
export const fmt1 = (v: number) => num1.format(v);
const toDate = (m: string) => new Date(`${m.length === 7 ? `${m}-01` : m}T00:00:00Z`);
export const fmtMonth = (m: string) => monthFmt.format(toDate(m)).replace(".", "");
export const fmtMonthLong = (m: string) => monthLong.format(toDate(m));
export const fmtDay = (d: string) => dayFmt.format(toDate(d));
