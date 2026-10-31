import { addDays } from "./worktime";
import type { Dataset, TimeEntry } from "./types";

/**
 * Booking-text assistant. Everything is derived from the company's own data (earlier bookings and Jira issues);
 * nothing is generated or invented, so every suggestion and summary line can be traced back to a booking or an issue.
 */

export interface ReasonSuggestion {
  text: string;
  /** jira: open issue of the sub-project; mine: own earlier booking; team: colleagues on the same sub-project. */
  source: "jira" | "mine" | "team";
  issueKey?: string;
}

/** Text of a booking without the leading issue key («KPR-12 Login» → «Login»). */
export const plainReason = (e: Pick<TimeEntry, "reason" | "jiraIssueKey">) =>
  e.jiraIssueKey && e.reason.startsWith(`${e.jiraIssueKey} `) ? e.reason.slice(e.jiraIssueKey.length + 1) : e.reason;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Up to `limit` suggestions for the reason field: issues in progress, then the person's own recent texts on the
 * sub-project (most recent first), then texts colleagues used there in the last 30 days (most hours first).
 * `typed` filters by substring; texts identical to it are left out.
 */
export function reasonSuggestions(
  data: Pick<Dataset, "timeEntries" | "issues">,
  opts: { employeeId: string; subProjectId: string; date: string; typed?: string; limit?: number },
): ReasonSuggestion[] {
  const limit = opts.limit ?? 4;
  const q = norm(opts.typed ?? "");
  const seen = new Set<string>(q ? [q] : []);
  const out: ReasonSuggestion[] = [];
  const add = (s: ReasonSuggestion) => {
    const k = norm(s.text);
    if (!k || seen.has(k) || (q && !k.includes(q))) return;
    seen.add(k);
    out.push(s);
  };
  const since = addDays(opts.date, -30);
  const recent = data.timeEntries.filter((e) => e.subProjectId === opts.subProjectId && !e.summary && e.date >= since && e.date <= opts.date);

  // Issues in progress that this person worked on lately come first, then other issues in progress.
  const mineOn = new Set(recent.filter((e) => e.employeeId === opts.employeeId && e.jiraIssueKey).map((e) => e.jiraIssueKey!));
  const open = data.issues.filter((i) => i.subProjectId === opts.subProjectId && i.status === "In Progress");
  for (const i of [...open.filter((i) => mineOn.has(i.key)), ...open.filter((i) => !mineOn.has(i.key))]) add({ text: i.summary, source: "jira", issueKey: i.key });

  const own = recent.filter((e) => e.employeeId === opts.employeeId).sort((a, b) => b.date.localeCompare(a.date) || (b.startTime ?? "").localeCompare(a.startTime ?? ""));
  for (const e of own) add({ text: plainReason(e), source: "mine", issueKey: e.jiraIssueKey });

  const team = new Map<string, { text: string; hours: number; issueKey?: string }>();
  for (const e of recent) {
    if (e.employeeId === opts.employeeId) continue;
    const t = plainReason(e);
    const x = team.get(norm(t)) ?? { text: t, hours: 0, issueKey: e.jiraIssueKey };
    x.hours += e.hours;
    team.set(norm(t), x);
  }
  for (const x of [...team.values()].sort((a, b) => b.hours - a.hours)) add({ text: x.text, source: "team", issueKey: x.issueKey });

  // Without a typed filter, keep a mix: at most two issues so own texts still show.
  if (!q) {
    const jira = out.filter((s) => s.source === "jira").slice(0, 2);
    const rest = out.filter((s) => s.source !== "jira");
    return [...jira, ...rest].slice(0, limit);
  }
  return out.slice(0, limit);
}

export interface MonthSummarySub {
  subProjectId: string;
  name: string;
  hours: number;
  /** Issues resolved this month with hours booked on them. */
  done: { key: string; summary: string }[];
  /** Activities with most hours (same text grouped), issue bookings excluded when the issue is listed as done. */
  topics: { text: string; hours: number }[];
}

export interface MonthSummaryProject {
  projectId: string;
  name: string;
  hours: number;
  subs: MonthSummarySub[];
}

/** What was done for a customer in a month, from bookings and resolved Jira issues; for the customer report text. */
export function monthSummary(data: Dataset, customerId: string, month: string, topics = 4): MonthSummaryProject[] {
  const projects = data.projects.filter((p) => p.customerId === customerId);
  const out: MonthSummaryProject[] = [];
  for (const p of projects) {
    const subs: MonthSummarySub[] = [];
    for (const s of data.subProjects.filter((x) => x.projectId === p.id)) {
      const entries = data.timeEntries.filter((e) => e.subProjectId === s.id && e.date.startsWith(month) && !e.summary);
      if (!entries.length) continue;
      const booked = new Set(entries.map((e) => e.jiraIssueKey).filter(Boolean));
      const done = data.issues
        .filter((i) => i.subProjectId === s.id && i.status === "Done" && i.resolvedAt?.startsWith(month) && booked.has(i.key))
        .map((i) => ({ key: i.key, summary: i.summary }));
      const doneKeys = new Set(done.map((d) => d.key));
      const groups = new Map<string, { text: string; hours: number }>();
      for (const e of entries) {
        if (e.jiraIssueKey && doneKeys.has(e.jiraIssueKey)) continue;
        const t = plainReason(e).trim();
        if (!t) continue;
        const g = groups.get(norm(t)) ?? { text: t, hours: 0 };
        g.hours += e.hours;
        groups.set(norm(t), g);
      }
      subs.push({
        subProjectId: s.id,
        name: s.name,
        hours: entries.reduce((x, e) => x + e.hours, 0),
        done,
        topics: [...groups.values()].sort((a, b) => b.hours - a.hours).slice(0, topics),
      });
    }
    if (subs.length) out.push({ projectId: p.id, name: p.name, hours: subs.reduce((x, s) => x + s.hours, 0), subs });
  }
  return out;
}
