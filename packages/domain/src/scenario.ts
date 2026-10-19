import { addMonths, monthOf, rateOn, statusFor, type BudgetStatus, type ProjectReport, type VelocityFactor } from "./calc";
import type { Dataset } from "./types";

/** Knobs of a what-if scenario on one project. */
export interface ScenarioInput {
  /** Hours per story point to plan with (default: current velocity). */
  factor?: number;
  /** Multiplier on the customer rate for the remaining work, 1 = unchanged. */
  rateFactor?: number;
  /** Story points added to (or removed from) the open scope. */
  spDelta?: number;
  /** Budget added to (or removed from) the project. */
  budgetDelta?: number;
  /** Capacity multiplier for the finish date: 1.5 = one and a half teams. */
  capacityFactor?: number;
}

export interface ScenarioResult {
  label: string;
  factor: number;
  remainingHours: number;
  forecastCost: number;
  budget: number;
  variance: number;
  status: BudgetStatus;
  completionMonth: string | null;
}

/** Same overhead share the report used: remaining hours per open SP, divided by the velocity factor. */
function overheadOf(report: ProjectReport, velocity: VelocityFactor | null): number {
  if (!velocity || report.spOpen === 0 || report.remainingHours === 0) return 1.15;
  return report.remainingHours / (report.spOpen * velocity.current);
}

/** Recomputes forecast, variance and finish month of a project under changed assumptions. */
export function scenario(data: Dataset, report: ProjectReport, velocity: VelocityFactor | null, w: ScenarioInput, label = "Szenario"): ScenarioResult {
  const factor = w.factor ?? velocity?.current ?? 0;
  const overhead = overheadOf(report, velocity);
  const spOpen = Math.max(0, report.spOpen + (w.spDelta ?? 0));
  const remainingHours = Math.max(0, spOpen * factor * overhead - Math.max(0, report.spOpen * (velocity?.current ?? 0) * overhead - report.remainingHours));
  const rate = rateOn(report.customer, data.today) * (w.rateFactor ?? 1);
  const forecastCost = report.actualCost + remainingHours * rate;
  const budget = report.budget + (w.budgetDelta ?? 0);
  // Finish: throughput of the last three months in SP, scaled by capacity.
  const current = monthOf(data.today);
  const recent = new Set([1, 2, 3].map((n) => addMonths(current, -n)));
  const subIds = new Set(report.subs.map((s) => s.subProject.id));
  const perMonth = (data.issues.filter((i) => subIds.has(i.subProjectId) && i.resolvedAt && recent.has(monthOf(i.resolvedAt))).reduce((s, i) => s + i.storyPoints, 0) / 3) * (w.capacityFactor ?? 1);
  const completionMonth = spOpen === 0 ? current : perMonth > 0 ? addMonths(current, Math.ceil(spOpen / perMonth) - 1) : null;
  return { label, factor, remainingHours, forecastCost, budget, variance: budget - forecastCost, status: statusFor(forecastCost, budget), completionMonth };
}

/** The three band scenarios of the velocity window plus the baseline. */
export function scenarioBand(data: Dataset, report: ProjectReport, velocity: VelocityFactor | null): ScenarioResult[] {
  if (!velocity) return [scenario(data, report, null, {}, "Erwartet")];
  return [
    scenario(data, report, velocity, { factor: velocity.low }, "Optimistisch"),
    scenario(data, report, velocity, { factor: velocity.current }, "Erwartet"),
    scenario(data, report, velocity, { factor: velocity.high }, "Pessimistisch"),
  ];
}
