// Booking from Slack and Microsoft Teams: one line of text, e.g. "2h30 Muster Website Startseite überarbeitet".
// Parsing and project matching live here so the server and the tests share them.

export type ChatCommand =
  | { kind: "help" }
  | { kind: "link" }
  | { kind: "today" }
  | { kind: "week" }
  | { kind: "book"; hours: number; daysAgo: number; words: string[] }
  | { kind: "unknown" };

const HELP = ["hilfe", "help", "aide", "aiuto", "?"];
const LINK = ["verbinden", "connect", "link", "connecter", "collega"];
const TODAY = ["heute", "today", "aujourd'hui", "aujourdhui", "oggi"];
const WEEK = ["woche", "week", "semaine", "settimana"];
const YESTERDAY = ["gestern", "yesterday", "hier", "ieri"];

/**
 * Hours from one or two tokens: "2h", "2.5h", "2,5", "1:30", "90m", "1h30", "2h 15m".
 * Returns the hours and how many tokens were used, or null.
 */
export function parseDuration(tokens: string[]): { hours: number; used: number } | null {
  const t0 = (tokens[0] ?? "").toLowerCase();
  let m: RegExpExecArray | null;
  let hours: number | null = null;
  if ((m = /^(\d{1,2}):([0-5]\d)$/.exec(t0))) hours = Number(m[1]) + Number(m[2]) / 60;
  else if ((m = /^(\d{1,2})h(\d{1,2})(?:m(?:in)?)?$/.exec(t0))) hours = Number(m[1]) + Number(m[2]) / 60;
  else if ((m = /^(\d{1,3})(?:m|min)$/.exec(t0))) hours = Number(m[1]) / 60;
  else if ((m = /^(\d{1,2}(?:[.,]\d{1,2})?)(?:h|std|hrs?)?$/.exec(t0))) hours = Number(m[1]!.replace(",", "."));
  if (hours === null) return null;
  let used = 1;
  // "2h 15m" as two tokens
  const t1 = (tokens[1] ?? "").toLowerCase();
  if (/h$/.test(t0) && (m = /^(\d{1,2})(?:m|min)$/.exec(t1))) {
    hours += Number(m[1]) / 60;
    used = 2;
  }
  if (!(hours > 0 && hours <= 24)) return null;
  return { hours: Math.round(hours * 100) / 100, used };
}

/** Text after the bot mention (Teams sends "<at>TrackInsight</at> …"), without HTML and extra spaces. */
export function cleanChatText(text: string) {
  return text
    .replace(/<at>[^<]*<\/at>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseChatCommand(raw: string): ChatCommand {
  const text = cleanChatText(raw);
  const words = text.split(" ").filter(Boolean);
  const first = (words[0] ?? "").toLowerCase();
  if (!first || HELP.includes(first)) return { kind: "help" };
  if (LINK.includes(first)) return { kind: "link" };
  if (TODAY.includes(first) && words.length === 1) return { kind: "today" };
  if (WEEK.includes(first) && words.length === 1) return { kind: "week" };
  let rest = words;
  let daysAgo = 0;
  if (YESTERDAY.includes(first)) {
    daysAgo = 1;
    rest = words.slice(1);
  }
  const d = parseDuration(rest);
  if (!d) return { kind: "unknown" };
  return { kind: "book", hours: d.hours, daysAgo, words: rest.slice(d.used) };
}

export interface ChatTarget {
  subProjectId: string;
  label: string;
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * The booking target named by the leading words: the most words that still match at least one target (every word
 * appears in "Customer Project Sub-project"). Leftover words are the booking text.
 */
export function matchChatTarget(words: string[], targets: ChatTarget[]):
  | { kind: "match"; target: ChatTarget; reason: string }
  | { kind: "ambiguous"; options: ChatTarget[] }
  | { kind: "none" } {
  const labels = targets.map((t) => ({ t, l: fold(t.label) }));
  let best: { k: number; hits: typeof labels } | null = null;
  for (let k = 1; k <= words.length; k++) {
    const probe = words.slice(0, k).map(fold);
    const hits = labels.filter(({ l }) => probe.every((w) => l.includes(w)));
    if (!hits.length) break;
    best = { k, hits };
    if (hits.length === 1) {
      // Keep taking words while they still describe this one target ("Muster Website Startseite").
      let k2 = k;
      while (k2 < words.length && hits[0]!.l.includes(fold(words[k2]!))) k2++;
      return { kind: "match", target: hits[0]!.t, reason: words.slice(k2).join(" ") };
    }
  }
  if (!best) return { kind: "none" };
  return { kind: "ambiguous", options: best.hits.slice(0, 6).map((h) => h.t) };
}
