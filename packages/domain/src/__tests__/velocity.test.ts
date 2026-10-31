import { describe, expect, it } from "vitest";
import { buildDataset } from "../sample";
import { velocityBreakdown } from "../calc";
import type { Dataset } from "../types";

describe("velocityBreakdown", () => {
  const data = buildDataset();
  const v = velocityBreakdown(data, 3);

  it("splits hours per SP by team and issue type over complete months", () => {
    expect(v.to < data.today.slice(0, 7)).toBe(true);
    expect(v.overall.hoursPerSp).toBeGreaterThan(0);
    expect(v.teams.map((t) => t.id).sort()).toEqual(["t1", "t2"].filter((id) => v.teams.some((t) => t.id === id)));
    // Team shares add up to the overall figures.
    expect(v.teams.reduce((s, t) => s + t.hours, 0)).toBeCloseTo(v.overall.hours, 3);
    expect(v.teams.reduce((s, t) => s + t.storyPoints, 0)).toBeCloseTo(v.overall.storyPoints, 3);
    const bug = v.types.find((t) => t.id === "Bug")!;
    const story = v.types.find((t) => t.id === "Story")!;
    expect(bug.hoursPerSp!).toBeGreaterThan(story.hoursPerSp!);
  });

  it("flags issues far above or below the factor", () => {
    expect(v.outliers.length).toBeGreaterThan(0);
    for (const o of v.outliers) expect(o.ratio >= 1.8 || o.ratio <= 1 / 1.8).toBe(true);
    const ratios = v.outliers.map((o) => Math.abs(Math.log(o.ratio)));
    expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);
  });

  it("weights an issue's points by each team's share of the hours", () => {
    const tiny: Dataset = {
      ...data,
      today: "2026-05-15",
      issues: [{ key: "X-1", summary: "a", subProjectId: "s1", storyPoints: 4, status: "Done", resolvedAt: "2026-04-10", issueType: "Story" }],
      timeEntries: [
        { id: "1", employeeId: "e1", subProjectId: "s1", date: "2026-04-08", hours: 6, reason: "", billable: true, hourlyRate: 100, jiraIssueKey: "X-1" },
        { id: "2", employeeId: "e6", subProjectId: "s1", date: "2026-04-09", hours: 2, reason: "", billable: true, hourlyRate: 100, jiraIssueKey: "X-1" },
      ],
    };
    const r = velocityBreakdown(tiny, 3);
    expect(r.teams.find((t) => t.id === "t1")).toMatchObject({ storyPoints: 3, hours: 6, hoursPerSp: 2 });
    expect(r.teams.find((t) => t.id === "t2")).toMatchObject({ storyPoints: 1, hours: 2, hoursPerSp: 2 });
  });
});
