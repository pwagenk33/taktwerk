import { describe, expect, it } from "vitest";
import { buildDataset } from "../sample";
import { currentVelocity, projectReports, velocityByMonth } from "../calc";
import { scenario, scenarioBand } from "../scenario";
import { utilization, upcomingAbsences } from "../utilization";
import { exportRows, toCsv } from "../export";

const data = buildDataset();
const settings = { method: "rolling" as const, window: 3 };
const reports = projectReports(data, settings);
const velocity = currentVelocity(velocityByMonth(data, settings), settings);

describe("scenarios", () => {
  it("reproduces the report at the current factor and moves with the knobs", () => {
    const r = reports.find((x) => x.project.id === "p1")!;
    const base = scenario(data, r, velocity, {});
    expect(base.forecastCost).toBeCloseTo(r.forecastCost, 0);
    expect(base.remainingHours).toBeCloseTo(r.remainingHours, 0);
    const band = scenarioBand(data, r, velocity);
    expect(band.map((b) => b.label)).toEqual(["Optimistisch", "Erwartet", "Pessimistisch"]);
    expect(band[0].forecastCost).toBeLessThanOrEqual(band[1].forecastCost);
    expect(band[1].forecastCost).toBeLessThanOrEqual(band[2].forecastCost);
    expect(scenario(data, r, velocity, { spDelta: 20 }).forecastCost).toBeGreaterThan(base.forecastCost);
    expect(scenario(data, r, velocity, { rateFactor: 0.9 }).forecastCost).toBeLessThan(base.forecastCost);
    expect(scenario(data, r, velocity, { budgetDelta: 50000 }).variance).toBeCloseTo(base.variance + 50000, 0);
    const faster = scenario(data, r, velocity, { capacityFactor: 2 });
    expect(faster.completionMonth! <= base.completionMonth!).toBe(true);
  });
});

describe("utilization and exports", () => {
  it("gives billable share per person for a month and a week", () => {
    const month = utilization(data, data.today.slice(0, 7));
    expect(month.length).toBe(data.employees.length);
    const lea = month.find((u) => u.name === "Lea Meier")!;
    expect(lea.due).toBeGreaterThan(0);
    expect(lea.utilization).not.toBeNull();
    const week = utilization(data, "2026-W42");
    expect(week[0].due).toBeGreaterThan(0);
    expect(Array.isArray(upcomingAbsences(data))).toBe(true);
  });
  it("exports Excel-friendly CSV", () => {
    const rows = exportRows(data, "time-entries", "2026-10-01", "2026-10-31");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("kunde");
    const csv = toCsv([{ a: 'x;"y"', b: 1, c: null }]);
    expect(csv).toBe('﻿a;b;c\r\n"x;""y""";1;\r\n');
    expect(exportRows(data, "projects")[0]).toHaveProperty("projektart");
  });
});
