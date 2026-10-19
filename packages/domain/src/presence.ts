/**
 * Work-time recording models under Swiss labour law and the «come/go» presence model.
 *
 * - simplified (Art. 73b ArGV 1): only the hours per day are recorded, which the bookings already give.
 *   Allowed for people with substantial autonomy over their working time, based on a written agreement.
 * - full (Art. 73 ArGV 1): begin and end of every work and break period («Kommen/Gehen»).
 */
export type TimeModel = "simplified" | "full";

export const TIME_MODELS: { id: TimeModel; label: string; hint: string }[] = [
  {
    id: "simplified",
    label: "Vereinfacht: nur Stunden pro Tag (Art. 73b ArGV 1)",
    hint: "Die Buchungen gelten als Arbeitszeiterfassung. Zulässig für Mitarbeitende mit grosser Autonomie bei der Arbeitszeit, mit schriftlicher Vereinbarung (Betrieb oder Einzelperson). Nacht- und Sonntagsarbeit ist trotzdem mit Beginn und Ende zu erfassen.",
  },
  {
    id: "full",
    label: "Vollständig: Kommen/Gehen mit Pausen (Art. 73 ArGV 1)",
    hint: "Jede Person stempelt Kommen, Pause und Gehen. Die App prüft die gesetzlichen Pausen (15 min ab 5½ h, 30 min ab 7 h, 60 min ab 9 h), die tägliche Ruhezeit von 11 Stunden und den Zeitrahmen von 14 Stunden.",
  },
];

export type PeriodKind = "work" | "break";

/** One stretch of work or break on a day; `end` is missing while the period is still open. */
export interface WorkPeriod {
  id: string;
  employeeId: string;
  date: string; // YYYY-MM-DD
  kind: PeriodKind;
  start: string; // HH:MM
  end?: string; // HH:MM
}

export type StampAction = "in" | "break" | "resume" | "out";

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const toClock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Legal minimum break for a day with this much work (Art. 15 ArG). */
export function requiredBreak(workMinutes: number): number {
  if (workMinutes > 9 * 60) return 60;
  if (workMinutes > 7 * 60) return 30;
  if (workMinutes > 5.5 * 60) return 15;
  return 0;
}

export interface DayPresence {
  date: string;
  /** Minutes of work and of breaks, open periods counted until `now`. */
  work: number;
  breaks: number;
  first?: string;
  last?: string;
  /** The period that is still running, if any. */
  open?: WorkPeriod;
  /** What the person is doing right now. */
  state: "off" | "working" | "break";
  periods: WorkPeriod[];
}

export function dayPresence(periods: WorkPeriod[], date: string, now?: string): DayPresence {
  const list = periods.filter((p) => p.date === date).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  let work = 0;
  let breaks = 0;
  let open: WorkPeriod | undefined;
  for (const p of list) {
    const end = p.end ?? now;
    if (!p.end) open = p;
    if (!end) continue;
    const len = Math.max(0, toMinutes(end) - toMinutes(p.start));
    if (p.kind === "work") work += len;
    else breaks += len;
  }
  const last = list.at(-1);
  return {
    date,
    work,
    breaks,
    first: list[0]?.start,
    last: last?.end,
    open,
    state: open ? (open.kind === "work" ? "working" : "break") : "off",
    periods: list,
  };
}

/** Which stamp actions make sense in the current state. */
export function stampOptions(state: DayPresence["state"]): StampAction[] {
  if (state === "off") return ["in"];
  if (state === "working") return ["break", "out"];
  return ["resume", "out"];
}

/**
 * Violations of the Labour Act on a closed day: missing break, span over 14 h, work after 23:00,
 * and (with the previous day's end) a rest time under 11 h. Empty when everything is fine.
 */
export function presenceIssues(day: DayPresence, previousDayLastEnd?: string): string[] {
  const issues: string[] = [];
  if (day.periods.length === 0) return issues;
  const needed = requiredBreak(day.work);
  if (needed > day.breaks) issues.push(`Pause zu kurz: ${day.breaks} min statt mindestens ${needed} min bei ${(day.work / 60).toFixed(1)} h Arbeit (Art. 15 ArG).`);
  const first = day.first ? toMinutes(day.first) : null;
  const lastEnd = day.periods.at(-1)?.end;
  const last = lastEnd ? toMinutes(lastEnd) : null;
  if (first !== null && last !== null && last - first > 14 * 60) issues.push("Zeitrahmen über 14 Stunden (Art. 10 ArG).");
  if (last !== null && last > 23 * 60) issues.push("Arbeit nach 23:00 gilt als Nachtarbeit und braucht eine Bewilligung (Art. 16 ArG).");
  if (first !== null && first < 6 * 60) issues.push("Arbeit vor 06:00 gilt als Nachtarbeit und braucht eine Bewilligung (Art. 16 ArG).");
  if (day.work > 12.5 * 60) issues.push("Mehr als 12½ Stunden Arbeit an einem Tag.");
  if (previousDayLastEnd && first !== null) {
    const rest = 24 * 60 - toMinutes(previousDayLastEnd) + first;
    if (rest < 11 * 60) issues.push(`Ruhezeit nur ${(rest / 60).toFixed(1)} h statt 11 h seit dem Vortag (Art. 15a ArG).`);
  }
  return issues;
}

/** Applies a stamp at `now` and returns the periods of the day afterwards (pure; ids are made by the caller). */
export function applyStamp(periods: WorkPeriod[], action: StampAction, employeeId: string, date: string, now: string, newId: () => string): WorkPeriod[] {
  const day = dayPresence(periods, date, now);
  if (!stampOptions(day.state).includes(action)) throw new Error("Dieser Schritt passt nicht zum aktuellen Zustand.");
  const close = (list: WorkPeriod[]) => list.map((p) => (p.id === day.open?.id ? { ...p, end: now } : p));
  const add = (list: WorkPeriod[], kind: PeriodKind) => [...list, { id: newId(), employeeId, date, kind, start: now }];
  switch (action) {
    case "in":
      return add(periods, "work");
    case "break":
      return add(close(periods), "break");
    case "resume":
      return add(close(periods), "work");
    case "out":
      return close(periods);
  }
}
