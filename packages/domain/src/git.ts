// Booking suggestions from GitHub and GitLab: the person's commits of a day become work blocks per repository,
// shown next to the calendar suggestions. A Jira key in a commit message («ABC-123») picks the project.
import type { CalendarEvent } from "./calendar";

export interface GitCommit {
  sha: string;
  /** "owner/repo" or the GitLab path with namespace. */
  repo: string;
  message: string;
  /** ISO time of the commit (author date) or the push. */
  at: string;
}

const zurich = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "2026-10-20T14:07:00Z" → { date: "2026-10-20", min: 967 } in Zurich time. */
function local(iso: string) {
  const parts = Object.fromEntries(zurich.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/;

/** Before the first commit of a session people already worked a while. */
const LEAD_MIN = 30;
/** A pause longer than this starts a new block. */
const GAP_MIN = 150;

/**
 * Commits grouped into work blocks: per repository and day, split at long pauses. Each block starts half an hour
 * before its first commit and ends at its last one (on the quarter hour), at least 30 minutes long.
 */
export function gitWorkBlocks(commits: GitCommit[]): CalendarEvent[] {
  const byKey = new Map<string, { date: string; repo: string; items: { min: number; message: string }[] }>();
  for (const c of commits) {
    const l = local(c.at);
    const key = `${l.date}|${c.repo}`;
    const g = byKey.get(key) ?? { date: l.date, repo: c.repo, items: [] };
    g.items.push({ min: l.min, message: c.message.split("\n")[0]!.trim() });
    byKey.set(key, g);
  }
  const out: CalendarEvent[] = [];
  for (const g of byKey.values()) {
    g.items.sort((a, b) => a.min - b.min);
    const sessions: (typeof g.items)[] = [];
    for (const it of g.items) {
      const cur = sessions.at(-1);
      if (cur && it.min - cur.at(-1)!.min <= GAP_MIN) cur.push(it);
      else sessions.push([it]);
    }
    const short = g.repo.split("/").pop() ?? g.repo;
    for (const s of sessions) {
      const start = Math.max(0, Math.floor((s[0]!.min - LEAD_MIN) / 15) * 15);
      const end = Math.min(24 * 60 - 1, Math.max(start + 30, Math.ceil(s.at(-1)!.min / 15) * 15));
      const messages = [...new Set(s.map((x) => x.message).filter((m) => m && !/^merge (branch|pull request)/i.test(m)))];
      const text = messages.join("; ") || "Commits";
      out.push({
        id: `git:${g.repo}:${g.date}:${clock(start)}`,
        title: `${short}: ${text}`.slice(0, 200),
        date: g.date,
        start: clock(start),
        end: clock(end),
        source: "git",
      });
    }
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
