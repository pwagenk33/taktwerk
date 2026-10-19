import { describe, expect, it } from "vitest";
import { buildDataset } from "../sample";
import type { Absence, Dataset } from "../types";
import { absenceDays, absenceProblem, defaultHolidays, easter, vacationSummary, workBalance } from "../worktime";

/** One person at 80 % (6.72 h/day at 42 h/week), March 2026, Good Friday 3 April. */
function team(absences: Absence[] = [], hours: Record<string, number> = {}): Dataset {
  return {
    teams: [],
    employees: [{ id: "e", name: "E", initials: "E", role: "employee", teamId: "", workload: 80, vacationDays: 20, trackingStart: "2026-03-01" }],
    customers: [],
    projects: [],
    subProjects: [],
    issues: [],
    expenses: [],
    timeEntries: Object.entries(hours).map(([date, h], i) => ({ id: `${i}`, employeeId: "e", subProjectId: "s", date, hours: h, reason: "", billable: true, hourlyRate: 0 })),
    absences,
    workModel: { weeklyHours: 42, holidays: defaultHolidays(2026) },
    today: "2026-04-03",
  };
}
const abs = (type: Absence["type"], startDate: string, endDate: string, extra: Partial<Absence> = {}): Absence =>
  ({ id: `${type}${startDate}`, employeeId: "e", type, startDate, endDate, halfDay: false, status: "approved", ...extra });

describe("holidays", () => {
  it("derives the Easter-based holidays", () => {
    expect(easter(2026)).toBe("2026-04-05");
    expect(easter(2027)).toBe("2027-03-28");
    const names = Object.fromEntries(defaultHolidays(2026).map((h) => [h.name, h.date]));
    expect(names).toMatchObject({ Karfreitag: "2026-04-03", Ostermontag: "2026-04-06", Auffahrt: "2026-05-14", Pfingstmontag: "2026-05-25" });
  });
});

describe("overtime balance", () => {
  it("counts target hours on working days only, from the tracking start", () => {
    // March 2026: 22 weekdays; 1–3 April: 2 weekdays before Good Friday.
    const b = workBalance(team(), "e");
    expect(b.from).toBe("2026-03-01");
    expect(b.months.map((m) => m.month)).toEqual(["2026-03", "2026-04"]);
    expect(b.months[0]!.target).toBeCloseTo(22 * 6.72);
    expect(b.months[1]!.target).toBeCloseTo(2 * 6.72);
    expect(b.balance).toBeCloseTo(-24 * 6.72);
  });

  it("credits absences, except compensation which uses up overtime", () => {
    const hours = { "2026-03-02": 10, "2026-03-03": 10 };
    const b = workBalance(team([abs("Krankheit", "2026-03-04", "2026-03-04"), abs("Ferien", "2026-03-05", "2026-03-05", { halfDay: true }), abs("Kompensation", "2026-03-06", "2026-03-06")], hours), "e");
    expect(b.months[0]!.absence).toBeCloseTo(1.5 * 6.72);
    expect(b.months[0]!.worked).toBe(20);
  });

  it("counts the running day only as far as it has been worked", () => {
    const morning = { ...team([], { "2026-04-02": 2 }), today: "2026-04-02" };
    const april = workBalance(morning, "e").months.at(-1)!;
    expect(april.target).toBeCloseTo(6.72 + 2); // 1 April in full, 2 April as far as worked
    const late = { ...team([], { "2026-04-02": 9 }), today: "2026-04-02" };
    expect(workBalance(late, "e").months.at(-1)!.balance).toBeCloseTo(9 - 2 * 6.72);
  });

  it("ignores requested and rejected absences", () => {
    const b = workBalance(team([abs("Ferien", "2026-03-02", "2026-03-06", { status: "requested" }), abs("Ferien", "2026-03-09", "2026-03-13", { status: "rejected" })]), "e");
    expect(b.months[0]!.absence).toBe(0);
  });
});

describe("vacation", () => {
  it("pro-rates the entitlement and counts working days only", () => {
    const data = team([
      abs("Ferien", "2026-03-30", "2026-04-07"), // 30, 31 Mar, 1, 2 Apr taken; 3 and 6 Apr holidays; 7 Apr planned
      abs("Ferien", "2026-07-06", "2026-07-10", { status: "requested" }),
    ]);
    expect(absenceDays(data, data.absences![0]!)).toBe(5);
    expect(vacationSummary(data, "e")).toEqual({ year: 2026, entitlement: 16.5, carry: 0, taken: 4, planned: 1, requested: 5, remaining: 11.5 });
  });

  it("refuses overlapping absences and ranges without working days", () => {
    const data = team([abs("Ferien", "2026-03-30", "2026-04-07")]);
    expect(absenceProblem(data, { employeeId: "e", type: "Krankheit", startDate: "2026-04-07", endDate: "2026-04-08", halfDay: false })).toMatch(/Überschneidet/);
    expect(absenceProblem(data, { employeeId: "e", type: "Ferien", startDate: "2026-03-07", endDate: "2026-03-08", halfDay: false })).toMatch(/kein Arbeitstag/);
    expect(absenceProblem(data, { employeeId: "e", type: "Ferien", startDate: "2026-04-09", endDate: "2026-04-08", halfDay: false })).toMatch(/Enddatum/);
  });
});

describe("example data", () => {
  it("keeps overtime balances in a realistic range", () => {
    const data = buildDataset();
    for (const e of data.employees) expect(Math.abs(workBalance(data, e.id).balance)).toBeLessThan(120);
  });
});
