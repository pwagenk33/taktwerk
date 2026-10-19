import { describe, expect, it } from "vitest";
import { buildDataset } from "../sample";
import { projectReports } from "../calc";
import { capacityPlan, loadStatus, planningWeeks } from "../planning";
import { isoWeekKey } from "../worktime";

const data = buildDataset();
const reports = projectReports(data, { method: "rolling", window: 3 });

describe("resource planning", () => {
  it("lists consecutive ISO weeks from today", () => {
    const weeks = planningWeeks(data.today, 4);
    expect(weeks).toHaveLength(4);
    expect(weeks[0]).toBe(isoWeekKey(data.today));
    expect(planningWeeks(data.today, 2, 1)[0]).toBe(weeks[1]);
  });

  it("grades the load of a week", () => {
    expect(loadStatus(0, 42)).toBe("idle");
    expect(loadStatus(30, 42)).toBe("ok");
    expect(loadStatus(40, 42)).toBe("tight");
    expect(loadStatus(45, 42)).toBe("over");
    expect(loadStatus(0, 0)).toBe("none");
  });

  it("compares planned hours with capacity and flags bottlenecks early", () => {
    const plan = capacityPlan(data, planningWeeks(data.today, 8), reports);
    expect(plan.people).toHaveLength(data.employees.length);
    const jonas = plan.people.find((p) => p.name === "Jonas Weber")!;
    // 80 % Pensum: 33.6 h capacity; week 2 and 3 carry 42 h.
    expect(jonas.cells[1].capacity).toBeCloseTo(33.6, 1);
    expect(jonas.cells[1].planned).toBe(42);
    expect(jonas.cells[1].status).toBe("over");
    expect(jonas.cells[0].status).toBe("tight");
    const warnings = plan.bottlenecks.filter((b) => b.kind === "person" && b.id === "e4");
    expect(warnings.map((w) => w.inWeeks)).toEqual([1, 2]);
    // Sara's vacation week (2026-10-05..09) lies in the past; in the horizon her capacity is full and so is her plan.
    const sara = plan.people.find((p) => p.name === "Sara Frei")!;
    expect(sara.cells[4].status).toBe("over");
    expect(plan.team[0].capacity).toBeGreaterThan(plan.team[0].planned);
    const p3 = plan.projects.find((p) => p.projectId === "p3")!;
    expect(p3.plannedTotal).toBeGreaterThan(0);
    expect(p3.cells).toHaveLength(8);
    expect(typeof p3.remainingHours === "number" || p3.remainingHours === null).toBe(true);
  });
});
