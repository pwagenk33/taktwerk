import { describe, expect, it } from "vitest";
import { calendarSuggestions } from "../calendar";
import { gitWorkBlocks } from "../git";

describe("git booking suggestions", () => {
  const commits = [
    { sha: "1", repo: "beispiel/shop", message: "SHOP-12 Warenkorb repariert\n\nDetails", at: "2026-10-20T07:10:00Z" }, // 09:10 Zurich
    { sha: "2", repo: "beispiel/shop", message: "Tests ergänzt", at: "2026-10-20T08:40:00Z" }, // 10:40
    { sha: "3", repo: "beispiel/shop", message: "Merge branch 'main'", at: "2026-10-20T08:41:00Z" },
    { sha: "4", repo: "beispiel/shop", message: "Abends noch Logging", at: "2026-10-20T16:00:00Z" }, // 18:00, new block
    { sha: "5", repo: "beispiel/app", message: "Login", at: "2026-10-20T12:00:00Z" },
  ];

  it("groups commits per repository and day into blocks with a lead time", () => {
    const blocks = gitWorkBlocks(commits);
    expect(blocks.map((b) => [b.title, b.start, b.end])).toEqual([
      ["shop: SHOP-12 Warenkorb repariert; Tests ergänzt", "08:30", "10:45"],
      ["app: Login", "13:30", "14:00"],
      ["shop: Abends noch Logging", "17:30", "18:00"],
    ]);
    expect(blocks[0]!.source).toBe("git");
  });

  it("uses the Jira key of a commit to pick the project and the issue", () => {
    const data = {
      timeEntries: [],
      customers: [{ id: "c", name: "Beispiel AG", rates: [] }],
      projects: [{ id: "p", customerId: "c", name: "Shop", budget: 0, jiraProjectKey: "SHOP" }],
      subProjects: [{ id: "s", projectId: "p", name: "Entwicklung", budget: 0 }],
    };
    const [first] = calendarSuggestions(gitWorkBlocks(commits), data as never, "u");
    expect(first).toMatchObject({ subProjectId: "s", because: "jira", jiraIssueKey: "SHOP-12", hours: 2.25 });
  });
});
