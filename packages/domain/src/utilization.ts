import { WorkCalendar, addDays, isoWeekKey, mondayOf, weekFigures } from "./worktime";
import { monthOf } from "./calc";
import type { Dataset, Employee } from "./types";

export interface UtilizationRow {
  employeeId: string;
  name: string;
  /** Hours due after absences and holidays. */
  due: number;
  worked: number;
  billable: number;
  /** billable / due, null without target hours. */
  utilization: number | null;
}

/** Billable share of the target hours per person for a month (YYYY-MM) or an ISO week key. */
export function utilization(data: Dataset, period: string, people: Employee[] = data.employees): UtilizationRow[] {
  const isWeek = period.includes("-W");
  return people.map((e) => {
    const cal = new WorkCalendar(data, e);
    let due = 0;
    if (isWeek) due = weekFigures(cal, period).due;
    else {
      const first = `${period}-01`;
      for (let d = first; monthOf(d) === period; d = addDays(d, 1)) due += cal.target(d) - cal.credit(d);
    }
    const own = data.timeEntries.filter((x) => x.employeeId === e.id && (isWeek ? isoWeekKey(x.date) === period : monthOf(x.date) === period));
    const worked = own.reduce((s, x) => s + x.hours, 0);
    const billable = own.filter((x) => x.billable && x.hourlyRate > 0).reduce((s, x) => s + x.hours, 0);
    return { employeeId: e.id, name: e.name, due: Math.round(due * 100) / 100, worked, billable, utilization: due > 0 ? billable / due : null };
  });
}

/** Planned absences in the coming weeks, one row per person and absence, soonest first. */
export function upcomingAbsences(data: Dataset, weeks = 8) {
  const until = addDays(mondayOf(data.today), weeks * 7);
  return (data.absences ?? [])
    .filter((a) => a.status !== "rejected" && a.endDate >= data.today && a.startDate <= until)
    .map((a) => ({ ...a, name: data.employees.find((e) => e.id === a.employeeId)?.name ?? "?" }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name));
}
