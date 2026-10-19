// Resource planning: capacity per person and ISO week against planned project hours, with early bottleneck warnings.
import { rateOn, type ProjectReport } from "./calc";
import { WorkCalendar, addDays, isoWeekKey, mondayOf, weekFigures } from "./worktime";
import type { Allocation, Dataset, Employee } from "./types";

export type LoadStatus = "idle" | "ok" | "tight" | "over" | "none";

export interface PlanCell {
  week: string;
  /** Hours available after absences and holidays. */
  capacity: number;
  planned: number;
  /** Hours already booked in that week (past and current weeks). */
  booked: number;
  free: number;
  status: LoadStatus;
}

export interface PlanRow {
  employeeId: string;
  name: string;
  cells: PlanCell[];
  plannedTotal: number;
  capacityTotal: number;
}

export interface ProjectPlanRow {
  projectId: string;
  name: string;
  customerName: string;
  cells: { week: string; planned: number }[];
  plannedTotal: number;
  /** Hours the remaining budget still pays for at today's rate; null for retainers or without budget/rate. */
  remainingHours: number | null;
  overPlanned: boolean;
}

export interface Bottleneck {
  kind: "person" | "project";
  week: string | null;
  id: string;
  name: string;
  /** Planned hours (person: in that week; project: in the horizon). */
  planned: number;
  /** Capacity (person) or remaining budget hours (project). */
  limit: number;
  /** Weeks from now until the problem week (0 = this week); null for project overplanning. */
  inWeeks: number | null;
}

export interface CapacityPlan {
  weeks: string[];
  people: PlanRow[];
  projects: ProjectPlanRow[];
  team: { week: string; capacity: number; planned: number }[];
  bottlenecks: Bottleneck[];
}

/** `count` ISO week keys starting at the week of `from` (default: today), shifted by `offset` weeks. */
export function planningWeeks(from: string, count = 12, offset = 0): string[] {
  const start = addDays(mondayOf(from), offset * 7);
  return Array.from({ length: count }, (_, i) => isoWeekKey(addDays(start, i * 7)));
}

export function loadStatus(planned: number, capacity: number): LoadStatus {
  if (capacity <= 0) return planned > 0 ? "over" : "none";
  const load = planned / capacity;
  if (planned > capacity + 0.5) return "over";
  if (load >= 0.9) return "tight";
  if (load < 0.5) return "idle";
  return "ok";
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Builds the planning grid: for every person the capacity, planned and booked hours per week, for every planned
 * project the hours per week against the remaining budget, and the list of bottlenecks (over-planned weeks and projects).
 */
export function capacityPlan(data: Dataset, weeks: string[], reports: ProjectReport[] = [], people: Employee[] = data.employees): CapacityPlan {
  const allocations = data.allocations ?? [];
  const thisWeek = isoWeekKey(data.today);
  const weekIndex = new Map(weeks.map((w, i) => [w, i]));

  const rows: PlanRow[] = people.map((e) => {
    const cal = new WorkCalendar(data, e);
    const cells = weeks.map((week) => {
      const capacity = r1(weekFigures(cal, week).due);
      const planned = r1(allocations.filter((a) => a.employeeId === e.id && a.week === week).reduce((s, a) => s + a.hours, 0));
      const booked = week <= thisWeek ? r1(data.timeEntries.filter((x) => x.employeeId === e.id && isoWeekKey(x.date) === week).reduce((s, x) => s + x.hours, 0)) : 0;
      return { week, capacity, planned, booked, free: r1(capacity - planned), status: loadStatus(planned, capacity) };
    });
    return { employeeId: e.id, name: e.name, cells, plannedTotal: r1(cells.reduce((s, c) => s + c.planned, 0)), capacityTotal: r1(cells.reduce((s, c) => s + c.capacity, 0)) };
  });

  const inHorizon = allocations.filter((a) => weekIndex.has(a.week));
  const projectIds = [...new Set(inHorizon.map((a) => a.projectId))];
  const projects: ProjectPlanRow[] = projectIds
    .map((pid) => {
      const p = data.projects.find((x) => x.id === pid);
      const customer = data.customers.find((c) => c.id === p?.customerId);
      const report = reports.find((r) => r.project.id === pid);
      const cells = weeks.map((week) => ({ week, planned: r1(inHorizon.filter((a) => a.projectId === pid && a.week === week).reduce((s, a) => s + a.hours, 0)) }));
      const plannedTotal = r1(cells.reduce((s, c) => s + c.planned, 0));
      const rate = customer ? rateOn(customer, data.today) : 0;
      const remainingHours = report && !report.retainer && report.budget > 0 && rate > 0 ? r1(Math.max(0, report.remainingBudget) / rate) : null;
      return { projectId: pid, name: p?.name ?? "?", customerName: customer?.name ?? "", cells, plannedTotal, remainingHours, overPlanned: remainingHours !== null && plannedTotal > remainingHours + 0.5 };
    })
    .sort((a, b) => b.plannedTotal - a.plannedTotal);

  const team = weeks.map((week, i) => ({ week, capacity: r1(rows.reduce((s, r) => s + r.cells[i]!.capacity, 0)), planned: r1(rows.reduce((s, r) => s + r.cells[i]!.planned, 0)) }));

  const bottlenecks: Bottleneck[] = [];
  for (const r of rows)
    for (const c of r.cells)
      if (c.status === "over" && c.week >= thisWeek) bottlenecks.push({ kind: "person", week: c.week, id: r.employeeId, name: r.name, planned: c.planned, limit: c.capacity, inWeeks: weekIndex.get(c.week)! - (weekIndex.get(thisWeek) ?? 0) });
  for (const p of projects) if (p.overPlanned) bottlenecks.push({ kind: "project", week: null, id: p.projectId, name: p.name, planned: p.plannedTotal, limit: p.remainingHours!, inWeeks: null });
  bottlenecks.sort((a, b) => (a.week ?? "9999").localeCompare(b.week ?? "9999") || a.name.localeCompare(b.name));

  return { weeks, people: rows, projects, team, bottlenecks };
}

/** Allocations of one person in one week, one line per project (for the editor). */
export function allocationsOf(data: Dataset, employeeId: string, week: string): Allocation[] {
  return (data.allocations ?? []).filter((a) => a.employeeId === employeeId && a.week === week);
}

export const weekLabel = (key: string) => `KW ${Number(key.split("-W")[1])}`;
