// Booking suggestions from the person's Outlook or Google calendar: each meeting that is not booked yet
// becomes a suggestion with duration and, where the history or the title gives it away, a sub-project.
import { JIRA_KEY } from "./git";
import type { Dataset } from "./types";

export interface CalendarEvent {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD, local time Zurich
  start: string; // HH:MM
  end: string; // HH:MM
  /** Where the block comes from; calendar when missing. */
  source?: "calendar" | "git";
}

export interface CalendarSuggestion {
  event: CalendarEvent;
  hours: number;
  subProjectId?: string;
  /** Why the sub-project was picked: an earlier booking with the same text, a name in the title, or a Jira key. */
  because?: "history" | "name" | "jira";
  /** Jira issue named in the title (e.g. a commit message «ABC-123 fix login»). */
  jiraIssueKey?: string;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/** Word-bounded match, so «App» does not hit «Apple». */
const mentions = (title: string, name: string) => {
  const n = norm(name);
  return n.length >= 3 && ` ${title} `.includes(` ${n} `);
};

/** «Alpenbank AG» is called «Alpenbank» in meeting titles. */
const LEGAL_FORM = /[\s,]+(ag|gmbh|sa|s\.a\.|sàrl|sarl|ltd|inc|llc|kg|se|genossenschaft)\.?$/i;

export function calendarSuggestions(events: CalendarEvent[], data: Pick<Dataset, "timeEntries" | "subProjects" | "projects" | "customers">, userId: string): CalendarSuggestion[] {
  const mine = data.timeEntries.filter((e) => e.employeeId === userId);
  const used = new Map<string, number>();
  for (const e of mine) used.set(e.subProjectId, (used.get(e.subProjectId) ?? 0) + 1);
  const mostUsed = (ids: string[]) => ids.sort((a, b) => (used.get(b) ?? 0) - (used.get(a) ?? 0))[0];

  const guess = (title: string): Pick<CalendarSuggestion, "subProjectId" | "because" | "jiraIssueKey"> => {
    const key = JIRA_KEY.exec(title);
    if (key) {
      const proj = data.projects.find((p) => p.jiraProjectKey?.toUpperCase() === key[1]);
      const subs = proj ? data.subProjects.filter((s) => s.projectId === proj.id).map((s) => s.id) : [];
      if (subs.length) return { subProjectId: mostUsed(subs), because: "jira", jiraIssueKey: key[0] };
    }
    const t = norm(title);
    if (!t) return {};
    const same = new Map<string, number>();
    for (const e of mine) {
      const r = norm(e.reason);
      if (r && (r === t || r.includes(t) || (r.length >= 6 && t.includes(r)))) same.set(e.subProjectId, (same.get(e.subProjectId) ?? 0) + 1);
    }
    if (same.size) return { subProjectId: [...same].sort((a, b) => b[1] - a[1])[0]![0], because: "history" };
    const sub = data.subProjects.filter((s) => mentions(t, s.name));
    if (sub.length) return { subProjectId: mostUsed(sub.map((s) => s.id)), because: "name" };
    const proj = new Set(data.projects.filter((p) => mentions(t, p.name)).map((p) => p.id));
    if (!proj.size) for (const c of data.customers) if (mentions(t, c.name.replace(LEGAL_FORM, ""))) data.projects.filter((p) => p.customerId === c.id).forEach((p) => proj.add(p.id));
    const subs = data.subProjects.filter((s) => proj.has(s.projectId)).map((s) => s.id);
    return subs.length ? { subProjectId: mostUsed(subs), because: "name" } : {};
  };

  const out: CalendarSuggestion[] = [];
  for (const ev of events) {
    const from = minutes(ev.start);
    const to = minutes(ev.end);
    if (to - from < 10) continue;
    // Already booked: any booking of the person that overlaps the meeting.
    const booked = mine.some((e) => {
      if (e.date !== ev.date || !e.startTime) return false;
      const s = minutes(e.startTime);
      return s < to && s + e.hours * 60 > from;
    });
    if (booked) continue;
    out.push({ event: ev, hours: Math.max(0.25, Math.round(((to - from) / 60) * 4) / 4), ...guess(ev.title) });
  }
  return out.sort((a, b) => (a.event.date + a.event.start).localeCompare(b.event.date + b.event.start));
}
