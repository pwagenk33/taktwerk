// Working time: target hours (Soll) from Pensum and holidays, worked hours (Ist), overtime balance and vacation.
import { monthOf } from "./calc";
import type { Absence, AbsenceType, Dataset, Employee, Holiday, WorkModel } from "./types";

export const ABSENCE_TYPES: AbsenceType[] = ["Ferien", "Krankheit", "Unfall", "Militär/Zivildienst", "Weiterbildung", "Kompensation", "Sonstiges"];

/** Types an employee requests and a lead approves. Sickness, accident and military service are recorded directly. */
export const NEEDS_APPROVAL: AbsenceType[] = ["Ferien", "Kompensation", "Weiterbildung", "Sonstiges"];

export const DEFAULT_WEEKLY_HOURS = 42;
export const DEFAULT_VACATION_DAYS = 25;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (date: string) => new Date(`${date}T00:00:00Z`);

export function addDays(date: string, n: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

export const isWeekday = (date: string) => {
  const wd = utc(date).getUTCDay();
  return wd !== 0 && wd !== 6;
};

/** All dates from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Easter Sunday (Gregorian calendar, anonymous algorithm). */
export function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Proposal for a year's holidays as observed in most German-speaking cantons (e.g. Zurich, Bern, Aargau).
 * Cantons differ, so admins adjust the list per organization.
 */
export function defaultHolidays(year: number): Holiday[] {
  const e = easter(year);
  const h = (date: string, name: string, fraction = 1) => ({ date, name, fraction });
  return [
    h(`${year}-01-01`, "Neujahr"),
    h(`${year}-01-02`, "Berchtoldstag"),
    h(addDays(e, -2), "Karfreitag"),
    h(addDays(e, 1), "Ostermontag"),
    h(addDays(e, 39), "Auffahrt"),
    h(addDays(e, 50), "Pfingstmontag"),
    h(`${year}-08-01`, "Bundesfeier"),
    h(`${year}-12-25`, "Weihnachten"),
    h(`${year}-12-26`, "Stephanstag"),
  ];
}

export function workModelOf(data: Dataset): WorkModel {
  if (data.workModel) return data.workModel;
  const y = Number(data.today.slice(0, 4));
  return { weeklyHours: DEFAULT_WEEKLY_HOURS, holidays: [y - 1, y, y + 1].flatMap(defaultHolidays) };
}

export const workloadOf = (e: Employee) => e.workload ?? 100;
export const trackingStartOf = (e: Employee, today: string) => e.trackingStart ?? `${today.slice(0, 4)}-01-01`;

/** Context for the per-day calculations of one person. */
export class WorkCalendar {
  readonly holidays: Map<string, Holiday>;
  readonly model: WorkModel;
  private readonly absences: Absence[];
  private readonly worked = new Map<string, number>();

  constructor(readonly data: Dataset, readonly employee: Employee) {
    this.model = workModelOf(data);
    this.holidays = new Map(this.model.holidays.map((h) => [h.date, h]));
    this.absences = (data.absences ?? []).filter((a) => a.employeeId === employee.id && a.status === "approved");
    for (const t of data.timeEntries) if (t.employeeId === employee.id) this.worked.set(t.date, (this.worked.get(t.date) ?? 0) + t.hours);
  }

  /** Share of a full working day that is a working day (0 on weekends and holidays, 0.5 on half holidays). */
  workShare(date: string): number {
    if (!isWeekday(date)) return 0;
    return 1 - (this.holidays.get(date)?.fraction ?? 0);
  }

  /** Target hours before absences. */
  target(date: string): number {
    return (this.model.weeklyHours / 5) * (workloadOf(this.employee) / 100) * this.workShare(date);
  }

  absenceOn(date: string): Absence | undefined {
    return this.absences.find((a) => a.startDate <= date && a.endDate >= date);
  }

  /**
   * Hours credited for an absence. Compensation days consume overtime, so they credit nothing.
   * A half-day absence on a half holiday credits the remaining half.
   */
  credit(date: string): number {
    const a = this.absenceOn(date);
    if (!a || a.type === "Kompensation") return 0;
    const full = (this.model.weeklyHours / 5) * (workloadOf(this.employee) / 100);
    return Math.min(this.target(date), a.halfDay ? full / 2 : full);
  }

  workedOn(date: string): number {
    return this.worked.get(date) ?? 0;
  }
}

/** Working days an absence takes (weekdays minus holidays, halved for half days). */
export function absenceDays(data: Dataset, a: Pick<Absence, "startDate" | "endDate" | "halfDay">): number {
  const holidays = new Map(workModelOf(data).holidays.map((h) => [h.date, h.fraction]));
  let days = 0;
  for (const d of daysBetween(a.startDate, a.endDate)) {
    if (!isWeekday(d)) continue;
    days += Math.min(1 - (holidays.get(d) ?? 0), a.halfDay ? 0.5 : 1);
  }
  return days;
}

export interface MonthBalance {
  month: string;
  /** Target hours before absences. */
  target: number;
  /** Hours credited by absences. */
  absence: number;
  worked: number;
  /** worked − (target − absence) */
  balance: number;
  /** Running overtime balance at the end of the month, including the carry-over. */
  cumulative: number;
}

export interface WorkBalance {
  employeeId: string;
  from: string;
  until: string;
  carry: number;
  months: MonthBalance[];
  /** Current overtime balance in hours (positive = overtime). */
  balance: number;
}

/** Overtime balance from the tracking start up to and including `until` (default: today). */
export function workBalance(data: Dataset, employeeId: string, until = data.today): WorkBalance {
  const employee = data.employees.find((e) => e.id === employeeId);
  if (!employee) throw new Error(`Unknown employee ${employeeId}`);
  const cal = new WorkCalendar(data, employee);
  const from = trackingStartOf(employee, data.today);
  const carry = employee.overtimeCarry ?? 0;
  const byMonth = new Map<string, MonthBalance>();
  let cumulative = carry;
  for (const d of from <= until ? daysBetween(from, until) : []) {
    const m = monthOf(d);
    const row = byMonth.get(m) ?? { month: m, target: 0, absence: 0, worked: 0, balance: 0, cumulative: 0 };
    let target = cal.target(d);
    const credit = cal.credit(d);
    const worked = cal.workedOn(d);
    // The running day only counts as far as it has been worked, so the balance does not dip every morning.
    if (d === data.today) target = Math.min(target, credit + worked);
    row.target += target;
    row.absence += credit;
    row.worked += worked;
    row.balance += worked - (target - credit);
    cumulative += worked - (target - credit);
    row.cumulative = cumulative;
    byMonth.set(m, row);
  }
  return { employeeId, from, until, carry, months: [...byMonth.values()], balance: cumulative };
}

export interface VacationSummary {
  year: number;
  /** Entitlement for the year, pro rata if tracking starts during the year. */
  entitlement: number;
  /** Days carried over from the previous year. */
  carry: number;
  /** Approved vacation days up to today. */
  taken: number;
  /** Approved vacation days after today. */
  planned: number;
  /** Vacation days requested and not decided yet. */
  requested: number;
  /** entitlement + carry − taken − planned */
  remaining: number;
}

const roundHalf = (v: number) => Math.round(v * 2) / 2;

export function vacationSummary(data: Dataset, employeeId: string, year = Number(data.today.slice(0, 4))): VacationSummary {
  const employee = data.employees.find((e) => e.id === employeeId);
  if (!employee) throw new Error(`Unknown employee ${employeeId}`);
  const start = trackingStartOf(employee, data.today);
  const startYear = Number(start.slice(0, 4));
  const perYear = employee.vacationDays ?? DEFAULT_VACATION_DAYS;
  const own = (data.absences ?? []).filter((a) => a.employeeId === employeeId && a.type === "Ferien");

  let carry = employee.vacationCarry ?? 0;
  let summary: VacationSummary | null = null;
  for (let y = Math.min(startYear, year); y <= year; y++) {
    if (y < startYear) continue;
    const from = y === startYear ? start : `${y}-01-01`;
    const monthsActive = 12 - (Number(from.slice(5, 7)) - 1);
    const entitlement = roundHalf((perYear * monthsActive) / 12);
    // Vacation days are counted on the days of this year only (a range over New Year is split).
    const count = (status: Absence["status"], pred: (d: string) => boolean) =>
      own
        .filter((a) => a.status === status)
        .reduce((s, a) => {
          const lo = a.startDate > from ? a.startDate : from;
          const hi = a.endDate < `${y}-12-31` ? a.endDate : `${y}-12-31`;
          if (lo > hi) return s;
          return s + daysBetween(lo, hi).filter(pred).reduce((n, d) => n + absenceDays(data, { startDate: d, endDate: d, halfDay: a.halfDay }), 0);
        }, 0);
    const taken = count("approved", (d) => d <= data.today);
    const planned = count("approved", (d) => d > data.today);
    const requested = count("requested", () => true);
    const remaining = entitlement + carry - taken - planned;
    summary = { year: y, entitlement, carry, taken, planned, requested, remaining };
    carry = remaining;
  }
  return summary ?? { year, entitlement: 0, carry: 0, taken: 0, planned: 0, requested: 0, remaining: 0 };
}

/** German error message if an absence is invalid or overlaps an existing one of the same person. */
export function absenceProblem(data: Dataset, a: Omit<Absence, "id" | "status">, ignoreId?: string): string | null {
  if (a.endDate < a.startDate) return "Das Enddatum liegt vor dem Startdatum.";
  if (daysBetween(a.startDate, a.endDate).length > 366) return "Eine Absenz kann höchstens ein Jahr dauern.";
  if (absenceDays(data, a) === 0) return "Im gewählten Zeitraum liegt kein Arbeitstag.";
  const clash = (data.absences ?? []).find(
    (x) => x.id !== ignoreId && x.employeeId === a.employeeId && x.status !== "rejected" && x.startDate <= a.endDate && x.endDate >= a.startDate,
  );
  if (clash) return `Überschneidet sich mit ${clash.type} vom ${fmtDate(clash.startDate)} bis ${fmtDate(clash.endDate)}.`;
  return null;
}

export const fmtDate = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;

/** Monday of the ISO week containing `date` (YYYY-MM-DD). */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** ISO week key such as 2026-W42 for a date. */
export function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - start) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday and Sunday of an ISO week key. */
export function weekRange(key: string): { from: string; to: string } {
  const [y, w] = key.split("-W").map(Number);
  // 4 January is always in week 1.
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7);
  const from = monday.toISOString().slice(0, 10);
  return { from, to: addDays(from, 6) };
}

/** Hours due (target minus credited absences) and worked in one ISO week for a person. */
export function weekFigures(cal: WorkCalendar, key: string): { due: number; worked: number } {
  const { from, to } = weekRange(key);
  let due = 0;
  let worked = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    due += cal.target(d) - cal.credit(d);
    worked += cal.workedOn(d);
  }
  return { due: Math.round(due * 100) / 100, worked: Math.round(worked * 100) / 100 };
}

