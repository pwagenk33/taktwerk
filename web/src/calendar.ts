// Booking suggestions from the person's Outlook or Google calendar (connected in Profile).
import { useEffect, useMemo, useState } from "react";
import { addDays, calendarSuggestions, type CalendarEvent, type CalendarSuggestion } from "@taktwerk/domain";
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
        const s = await loadCalendarStatus(demo);
        if (!s.connected) return live && setEvents([]);
        // Only what is past or today: future meetings are not booked yet.
        const until = to < data.today ? to : data.today;
        if (from > until) return live && setEvents([]);
        if (demo) {
          const names = data.projects.filter((p) => p.jiraProjectKey).map((p) => ({ project: p.name, customer: data.customers.find((c) => c.id === p.customerId)?.name.replace(/\s+(AG|GmbH|SA)$/, "") ?? "" }));
          const all: string[] = [];
          for (let d = from; d <= until; d = addDays(d, 1)) all.push(d);
          return live && setEvents(demoEvents(all, names));
        }
        const list = await api<CalendarEvent[]>(`/api/calendar/events?from=${from}&to=${until}`);
        if (live) setEvents(list);
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
