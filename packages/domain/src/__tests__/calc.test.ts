import { describe, expect, it } from "vitest";
import { buildDataset } from "../sample";
import { currentVelocity, projectReports, rateOn, velocityByMonth } from "../calc";
import type { Dataset } from "../types";

const settings = { method: "rolling" as const, window: 3 };

function tiny(): Dataset {
  return {
    teams: [{ id: "t", name: "T" }],
    employees: [{ id: "e", name: "E", initials: "E", role: "employee", teamId: "t" }],
    customers: [{ id: "c", name: "C", rates: [{ validFrom: "2026-01-01", hourlyRate: 100 }] }],
    projects: [{ id: "p", customerId: "c", name: "P", budget: 10000 }],
    subProjects: [{ id: "s", projectId: "p", name: "S", budget: 10000 }],
    issues: [
      { key: "A-1", summary: "", subProjectId: "s", storyPoints: 10, status: "Done", resolvedAt: "2026-01-20" },
      { key: "A-2", summary: "", subProjectId: "s", storyPoints: 10, status: "Done", resolvedAt: "2026-02-20" },
      { key: "A-3", summary: "", subProjectId: "s", storyPoints: 5, status: "In Progress" },
    ],
    timeEntries: [
      { id: "1", employeeId: "e", subProjectId: "s", date: "2026-01-10", hours: 30, reason: "", billable: true, hourlyRate: 100, jiraIssueKey: "A-1" },
      { id: "2", employeeId: "e", subProjectId: "s", date: "2026-02-10", hours: 50, reason: "", billable: true, hourlyRate: 100, jiraIssueKey: "A-2" },
      { id: "3", employeeId: "e", subProjectId: "s", date: "2026-03-02", hours: 5, reason: "", billable: true, hourlyRate: 100, jiraIssueKey: "A-3" },
    ],
    expenses: [{ id: "x", employeeId: "e", subProjectId: "s", date: "2026-02-01", amount: 200, category: "Reise", reason: "", billable: true }],
    today: "2026-03-15",
  };
}

describe("velocity", () => {
  it("computes monthly and SP-weighted rolling hours per SP", () => {
    const v = velocityByMonth(tiny(), settings);
    expect(v.map((m) => m.hoursPerSp)).toEqual([3, 5, null]);
    expect(v[1].smoothed).toBe(4); // (30 + 50) / (10 + 10)
    const cur = currentVelocity(v, settings)!;
    expect(cur).toMatchObject({ current: 4, low: 3, high: 5, asOf: "2026-02" });
  });

  it("reproduces the drift in the example data", () => {
    const v = velocityByMonth(buildDataset(), settings);
    expect(v[0].hoursPerSp!).toBeGreaterThan(3);
    expect(v[0].hoursPerSp!).toBeLessThan(4.2);
    expect(currentVelocity(v, settings)!.current).toBeGreaterThan(5.8);
  });
});

describe("forecast", () => {
  it("adds open SP times factor, minus hours already on open issues", () => {
    const [p] = projectReports(tiny(), settings);
    const s = p.subs[0];
    expect(s.actualCost).toBe(8500 + 200);
    // 5 SP * 4 h - 5 h booked = 15 h; no hours without issue, so no overhead surcharge
    expect(s.remainingHours).toBeCloseTo(15);
    expect(s.forecastCost).toBeCloseTo(8700 + 15 * 100);
    expect(s.status).toBe("over"); // 10'200 > 10'000
  });

  it("uses the rate valid at the date", () => {
    const c = { id: "c", name: "", rates: [{ validFrom: "2026-01-01", hourlyRate: 100 }, { validFrom: "2026-07-01", hourlyRate: 120 }] };
    expect(rateOn(c, "2026-06-30")).toBe(100);
    expect(rateOn(c, "2026-07-01")).toBe(120);
  });

  it("example data shows every status", () => {
    const subs = projectReports(buildDataset(), settings).flatMap((p) => p.subs);
    expect(new Set(subs.map((s) => s.status))).toEqual(new Set(["ok", "risk", "over"]));
  });
});

describe("expenses in reports", () => {
  it("counts only approved, billable expenses", async () => {
    const { countsExpense } = await import("../calc");
    const base = { id: "x", employeeId: "e", subProjectId: "s", date: "2026-01-01", amount: 10, category: "Reise" as const, reason: "r" };
    expect(countsExpense({ ...base, billable: true })).toBe(true);
    expect(countsExpense({ ...base, billable: true, status: "approved" })).toBe(true);
    expect(countsExpense({ ...base, billable: true, status: "requested" })).toBe(false);
    expect(countsExpense({ ...base, billable: true, status: "rejected" })).toBe(false);
    expect(countsExpense({ ...base, billable: false, status: "approved" })).toBe(false);
  });
});

describe("profitability and currencies", () => {
  it("computes margin per project and customer in CHF with FX conversion", async () => {
    const { buildDataset } = await import("../sample");
    const { profitability, projectReports, toChf, fmtMoney } = await import("../index");
    const data = buildDataset();
    const reports = projectReports(data, { method: "rolling", window: 3 });
    const p = profitability(data, reports);
    expect(p.projects.length).toBe(data.projects.length - 1); // internal work is kept apart
    expect(p.internal.hours).toBeGreaterThan(0);
    const medtech = p.customers.find((c) => c.name === "Medtech Basel AG")!;
    expect(medtech.currency).toBe("EUR");
    // EUR revenue converted at 0.94 lies below the raw rate × hours.
    const raw = data.timeEntries.filter((e) => e.billable && data.subProjects.some((s) => s.id === e.subProjectId && data.projects.some((pr) => pr.id === s.projectId && pr.customerId === "c3"))).reduce((s, e) => s + e.hours * e.hourlyRate, 0);
    expect(medtech.revenue).toBeLessThan(raw);
    expect(p.total.marginPct).not.toBeNull();
    expect(toChf(100, "EUR", data.fx)).toBeCloseTo(94);
    expect(fmtMoney(1234, "EUR")).toContain("1’234");
    const retainer = reports.find((r) => r.project.id === "p2")!;
    expect(retainer.kind).toBe("retainer");
    expect(retainer.retainer?.hoursPerMonth).toBe(120);
  });
});
