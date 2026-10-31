import { describe, expect, it } from "vitest";
import { monthSummary, reasonSuggestions } from "../assist";
import type { Dataset, TimeEntry } from "../types";

const entry = (id: string, employeeId: string, date: string, reason: string, hours = 1, jiraIssueKey?: string): TimeEntry =>
  ({ id, employeeId, subProjectId: "s1", date, hours, reason, billable: true, hourlyRate: 100, jiraIssueKey });

const data = {
  timeEntries: [
    entry("1", "e1", "2026-10-28", "Abnahme vorbereitet"),
    entry("2", "e1", "2026-10-29", "KPR-7 Login mit Passkey", 2, "KPR-7"),
    entry("3", "e2", "2026-10-27", "Sprint Review", 3),
    entry("4", "e2", "2026-10-20", "Daily", 0.5),
    entry("5", "e1", "2026-08-01", "Uralt"),
    entry("6", "e1", "2026-10-30", "KPR-8 Kontoauszug als PDF", 4, "KPR-8"),
  ],
  issues: [
    { key: "KPR-7", summary: "Login mit Passkey", subProjectId: "s1", storyPoints: 3, status: "In Progress" },
    { key: "KPR-9", summary: "Push-Nachrichten", subProjectId: "s1", storyPoints: 5, status: "In Progress" },
    { key: "KPR-8", summary: "Kontoauszug als PDF", subProjectId: "s1", storyPoints: 2, status: "Done", resolvedAt: "2026-10-30" },
  ],
} as unknown as Dataset;

describe("reasonSuggestions", () => {
  it("offers own issues in progress, own recent texts and the team's", () => {
    const s = reasonSuggestions(data, { employeeId: "e1", subProjectId: "s1", date: "2026-10-31", limit: 6 });
    expect(s.map((x) => x.text)).toEqual(["Login mit Passkey", "Push-Nachrichten", "Kontoauszug als PDF", "Abnahme vorbereitet", "Sprint Review", "Daily"]);
    expect(s[0]).toMatchObject({ source: "jira", issueKey: "KPR-7" });
    expect(s.find((x) => x.text === "Sprint Review")!.source).toBe("team");
    expect(s.some((x) => x.text === "Uralt")).toBe(false);
  });

  it("filters by what was typed", () => {
    const s = reasonSuggestions(data, { employeeId: "e1", subProjectId: "s1", date: "2026-10-31", typed: "ab" });
    expect(s.map((x) => x.text)).toEqual(["Abnahme vorbereitet"]);
    expect(reasonSuggestions(data, { employeeId: "e1", subProjectId: "s1", date: "2026-10-31", typed: "Abnahme vorbereitet" })).toEqual([]);
  });
});

describe("monthSummary", () => {
  it("lists resolved issues and the activities with most hours per sub-project", () => {
    const d = { ...data, projects: [{ id: "p1", customerId: "c1", name: "Portal", budget: 0 }], subProjects: [{ id: "s1", projectId: "p1", name: "Login", budget: 0 }] } as unknown as Dataset;
    const [p] = monthSummary(d, "c1", "2026-10");
    expect(p.hours).toBe(10.5);
    expect(p.subs[0].done).toEqual([{ key: "KPR-8", summary: "Kontoauszug als PDF" }]);
    expect(p.subs[0].topics.map((t) => t.text)).toEqual(["Sprint Review", "Login mit Passkey", "Abnahme vorbereitet", "Daily"]);
    expect(monthSummary(d, "c1", "2026-09")).toEqual([]);
  });
});
