import { describe, expect, it } from "vitest";
import { payrollAbacus, payrollRows, payrollTable } from "../payroll";
import type { Dataset } from "../types";
import { defaultHolidays } from "../worktime";

/** One person at 100 % (8.4 h/day), March 2026 has 22 weekdays. */
const data: Dataset = {
  teams: [],
  employees: [{ id: "e", name: "Lea Meier", initials: "LM", role: "employee", teamId: "", trackingStart: "2026-03-01", personnelNumber: "1042" }],
  customers: [],
  projects: [],
  subProjects: [],
  issues: [],
  timeEntries: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, employeeId: "e", subProjectId: "s", date: `2026-03-${String(2 + i).padStart(2, "0")}`, hours: 9, reason: "", billable: true, hourlyRate: 0 })),
  expenses: [
    { id: "x1", employeeId: "e", subProjectId: "s", date: "2026-03-10", amount: 88.4, category: "Reise", reason: "", billable: true },
    { id: "x2", employeeId: "e", subProjectId: "s", date: "2026-03-11", amount: 35, category: "Kilometer", km: 50, reason: "", billable: true },
    { id: "x3", employeeId: "e", subProjectId: "s", date: "2026-03-12", amount: 500, category: "Material", reason: "", billable: true, status: "requested" },
  ],
  absences: [
    { id: "a1", employeeId: "e", type: "Krankheit", startDate: "2026-03-30", endDate: "2026-04-02", halfDay: false, status: "approved" },
    { id: "a2", employeeId: "e", type: "Ferien", startDate: "2026-03-26", endDate: "2026-03-27", halfDay: false, status: "requested" },
  ],
  workModel: { weeklyHours: 42, holidays: defaultHolidays(2026) },
  today: "2026-04-15",
};

describe("payroll export", () => {
  it("adds up hours, overtime, approved absences and approved expenses per month", () => {
    const rows = payrollRows(data, "2026-03", { hours: "100", sick: "" });
    const by = Object.fromEntries(rows.map((r) => [r.item, r]));
    expect(by.hours).toMatchObject({ personnelNumber: "1042", code: "100", quantity: 180, unit: "h" });
    // 22 days × 8.4 h, minus 2 sick days credited.
    expect(by.target!.quantity).toBeCloseTo(20 * 8.4);
    expect(by.overtime!.quantity).toBeCloseTo(180 - 20 * 8.4);
    expect(by.sick).toMatchObject({ code: "2100", quantity: 2, unit: "d" });
    expect(by.vacation).toBeUndefined();
    expect(by.expenses).toMatchObject({ amount: 88.4 });
    expect(by.mileage).toMatchObject({ amount: 35 });
  });

  it("counts an absence over the month end in each month", () => {
    const april = payrollRows(data, "2026-04");
    expect(april.find((r) => r.item === "sick")!.quantity).toBe(2);
    expect(payrollTable(april)[0]).toMatchObject({ personalnummer: "1042", name: "Lea Meier", periode: "2026-04" });
  });

  it("writes Abacus variable payroll data with the month's last day and no info-only lines", () => {
    const lines = payrollAbacus(payrollRows(data, "2026-03", { hours: "100" })).trim().split("\r\n");
    expect(lines[0]).toBe("MANR;LOHNART;DATUM;ANZAHL;ANSATZ;BETRAG;TEXT");
    expect(lines).toContain("1042;100;31.03.2026;180.00;;;Geleistete Stunden");
    expect(lines).toContain("1042;6000;31.03.2026;1;;88.40;Spesen (ohne Kilometer)");
    expect(lines.some((l) => l.includes(";1001;"))).toBe(false);
    expect(lines.some((l) => l.includes(";1101;"))).toBe(false);
  });
});
