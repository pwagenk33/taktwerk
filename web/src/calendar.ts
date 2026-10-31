// Booking suggestions from the person's Outlook or Google calendar (connected in Profile).
import { useEffect, useMemo, useState } from "react";
import { addDays, calendarSuggestions, gitWorkBlocks, type CalendarEvent, type CalendarSuggestion, type GitCommit } from "@taktwerk/domain";
import { api } from "./api";
import { loadLocal, saveLocal, useStore } from "./store";
import { tr } from "./i18n";

export interface CalendarStatus {
  providers: { microsoft: boolean; google: boolean };
  connected: { provider: "microsoft" | "google"; account: string | null } | null;
}

const DEMO_KEY = "rt.calendar.demo";
export const providerLabel = (p: "microsoft" | "google") => (p === "microsoft" ? "Outlook (Microsoft 365)" : tr("Google Kalender"));

export async function loadCalendarStatus(demo: boolean): Promise<CalendarStatus> {
  if (demo) {
    const p = loadLocal<"microsoft" | "google" | null>(DEMO_KEY, "microsoft");
    return { providers: { microsoft: true, google: true }, connected: p ? { provider: p, account: "anna.keller@beispiel.ch" } : null };
  }
  return api<CalendarStatus>("/api/calendar");
}
export const setDemoCalendar = (p: "microsoft" | "google" | null) => saveLocal(DEMO_KEY, p);

/** Prototype: a plausible week of meetings, named after the sample customers and projects. */
function demoEvents(days: string[], names: { customer: string; project: string }[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const [a, b] = [names[0], names[1] ?? names[0]];
  days.slice(0, 5).forEach((d, i) => {
    out.push({ id: `${d}-daily`, title: tr("Daily Standup"), date: d, start: "09:00", end: "09:15" });
    if (i === 1 && a) out.push({ id: `${d}-ws`, title: tr("Workshop {0}", a.customer), date: d, start: "14:00", end: "15:30" });
    if (i === 3 && b) out.push({ id: `${d}-review`, title: tr("Sprint Review {0}", b.project), date: d, start: "10:00", end: "11:00" });
    if (i === 4) out.push({ id: `${d}-retro`, title: tr("Retrospektive"), date: d, start: "15:00", end: "16:00" });
  });
  return out;
}

export interface GitStatus { connected: { provider: "github" | "gitlab"; account: string; baseUrl: string } | null }
const GIT_DEMO_KEY = "rt.git.demo";
export async function loadGitStatus(demo: boolean): Promise<GitStatus> {
  if (demo) {
    const p = loadLocal<"github" | "gitlab" | null>(GIT_DEMO_KEY, "github");
    return { connected: p ? { provider: p, account: "anna-keller", baseUrl: p === "github" ? "https://api.github.com" : "https://gitlab.com" } : null };
  }
  return api<GitStatus>("/api/git");
}
export const setDemoGit = (p: "github" | "gitlab" | null) => saveLocal(GIT_DEMO_KEY, p);

/** Prototype: a few commits on the sample projects with Jira keys, so the suggestions pick the project. */
function demoCommits(days: string[], projects: { name: string; key: string }[]): GitCommit[] {
  const out: GitCommit[] = [];
  const p = projects[0];
  if (!p) return out;
  const repo = `beispiel/${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+01:00`).toISOString();
  days.slice(0, 5).forEach((d, i) => {
    if (i === 0) out.push({ sha: `${d}a`, repo, message: tr("{0}-41 Suche beschleunigt", p.key), at: at(d, "10:50") }, { sha: `${d}b`, repo, message: tr("{0}-41 Tests ergänzt", p.key), at: at(d, "11:40") });
    if (i === 2) out.push({ sha: `${d}c`, repo, message: tr("{0}-44 Export korrigiert", p.key), at: at(d, "16:20") });
  });
  return out;
}

const hiddenKey = (userId: string) => `rt.cal.hidden.${userId}`;

/** Suggestions for the visible days; meetings that are already booked or dismissed do not show. */
export function useCalendarSuggestions(days: string[]) {
  const { mode, data, currentUserId } = useStore();
  const demo = mode === "demo";
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [hidden, setHidden] = useState<string[]>(() => loadLocal<string[]>(hiddenKey(currentUserId), []));
  const from = days[0]!;
  const to = days[days.length - 1]!;
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // Only what is past or today: future meetings are not booked yet.
        const until = to < data.today ? to : data.today;
        if (from > until) return live && setEvents([]);
        const [cal, git] = await Promise.all([loadCalendarStatus(demo).catch(() => null), loadGitStatus(demo).catch(() => null)]);
        const all: string[] = [];
        for (let d = from; d <= until; d = addDays(d, 1)) all.push(d);
        const meetings: Promise<CalendarEvent[]> = !cal?.connected
          ? Promise.resolve([])
          : demo
            ? Promise.resolve(demoEvents(all, data.projects.filter((p) => p.jiraProjectKey).map((p) => ({ project: p.name, customer: data.customers.find((c) => c.id === p.customerId)?.name.replace(/\s+(AG|GmbH|SA)$/, "") ?? "" }))))
            : api<CalendarEvent[]>(`/api/calendar/events?from=${from}&to=${until}`).catch(() => []);
        const commits: Promise<GitCommit[]> = !git?.connected
          ? Promise.resolve([])
          : demo
            ? Promise.resolve(demoCommits(all, data.projects.filter((p) => p.jiraProjectKey).map((p) => ({ name: p.name, key: p.jiraProjectKey! }))))
            : api<GitCommit[]>(`/api/git/commits?from=${from}&to=${until}`).catch(() => []);
        const [m, c] = await Promise.all([meetings, commits]);
        if (live) setEvents([...m, ...gitWorkBlocks(c).filter((b) => b.date >= from && b.date <= until)]);
      } catch {
        if (live) setEvents([]);
      }
    })();
    return () => { live = false; };
  }, [from, to, demo]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = useMemo<CalendarSuggestion[]>(
    () => calendarSuggestions(events.filter((e) => !hidden.includes(e.id)), data, currentUserId),
    [events, hidden, data, currentUserId],
  );
  const hide = (id: string) => {
    const next = [...hidden.slice(-300), id];
    setHidden(next);
    saveLocal(hiddenKey(currentUserId), next);
  };
  return { suggestions, hide };
}
