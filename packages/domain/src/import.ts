// Importing bookings from other tools: CSV parsing, recognising the export of Clockodo, Toggl Track and Harvest,
// and turning each line into a booking the app understands. Excel files arrive here already as rows of text.

export type ImportSource = "clockodo" | "toggl" | "harvest" | "generic";

/** The fields a booking needs; every other column of the file is ignored. */
export type ImportField = "date" | "person" | "email" | "customer" | "project" | "task" | "description" | "hours" | "start" | "end" | "billable";

export type ImportMapping = Partial<Record<ImportField, number>>;

export interface ImportRow {
  line: number;
  date: string;
  person: string;
  email?: string;
  customer: string;
  project: string;
  task: string;
  reason: string;
  hours: number;
  billable: boolean;
  startTime?: string;
}

export interface ImportProblem {
  line: number;
  message: string;
}

export const IMPORT_FIELDS: { id: ImportField; label: string; required?: boolean }[] = [
  { id: "date", label: "Datum", required: true },
  { id: "person", label: "Person", required: true },
  { id: "email", label: "E-Mail der Person" },
  { id: "customer", label: "Kunde", required: true },
  { id: "project", label: "Projekt", required: true },
  { id: "task", label: "Tätigkeit oder Aufgabe" },
  { id: "description", label: "Beschreibung" },
  { id: "hours", label: "Dauer" },
  { id: "start", label: "Beginn (Uhrzeit)" },
  { id: "end", label: "Ende (Uhrzeit)" },
  { id: "billable", label: "Verrechenbar" },
];

export const IMPORT_SOURCES: { id: ImportSource; label: string; hint: string }[] = [
  { id: "clockodo", label: "Clockodo", hint: "Berichte → Stundenzettel oder Einträge, als CSV oder Excel exportieren." },
  { id: "toggl", label: "Toggl Track", hint: "Reports → Detailed → Export → CSV." },
  { id: "harvest", label: "Harvest", hint: "Reports → Detailed time → Export → CSV." },
  { id: "generic", label: "Excel oder andere", hint: "Eine Zeile pro Buchung mit Datum, Person, Kunde, Projekt und Dauer. Die Spalten ordnen Sie im nächsten Schritt zu." },
];

/** Column names per field, lower case, as the tools write them in German and English. */
const ALIASES: Record<ImportField, string[]> = {
  date: ["datum", "date", "start date", "startdatum", "tag", "day"],
  person: ["mitarbeiter", "mitarbeiterin", "mitarbeitende", "person", "user", "benutzer", "name", "employee", "member", "teammitglied"],
  email: ["email", "e-mail", "mail", "user email"],
  customer: ["kunde", "client", "customer", "auftraggeber"],
  project: ["projekt", "project", "project name"],
  task: ["leistung", "tätigkeit", "task", "aufgabe", "service", "tags"],
  description: ["beschreibung", "description", "notes", "notiz", "bemerkung", "text", "kommentar"],
  hours: ["dauer", "duration", "hours", "stunden", "zeit", "dauer (h)", "dauer in stunden", "time"],
  start: ["start time", "startzeit", "beginn", "von", "start"],
  end: ["end time", "endzeit", "ende", "bis", "end"],
  billable: ["abrechenbar", "verrechenbar", "billable", "billable?", "fakturierbar"],
};

/** Columns that only one tool writes; they tell which export a file is. */
const SIGNATURE: Record<Exclude<ImportSource, "generic">, string[]> = {
  toggl: ["start date", "start time", "end time", "duration", "client"],
  harvest: ["hours rounded", "billable?", "first name", "last name"],
  clockodo: ["leistung", "mitarbeiter", "kunde"],
};

const norm = (s: string) => s.replace(/^﻿/, "").trim().toLowerCase().replace(/\s+/g, " ");

/** Splits CSV text into rows. Detects comma, semicolon or tab, understands quotes, line breaks in quotes and a BOM. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const firstLine = t.slice(0, t.search(/\r?\n/) === -1 ? t.length : t.search(/\r?\n/));
  const count = (c: string) => firstLine.split(c).length - 1;
  const delim = [";", "\t", ","].reduce((best, c) => (count(c) > count(best) ? c : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** Which tool wrote the file, judged by its column names. */
export function detectSource(header: string[]): ImportSource {
  const h = header.map(norm);
  let best: ImportSource = "generic";
  let score = 1;
  for (const [src, cols] of Object.entries(SIGNATURE) as [Exclude<ImportSource, "generic">, string[]][]) {
    const s = cols.filter((c) => h.includes(c)).length;
    if (s > score) { best = src; score = s; }
  }
  return best;
}

/** Suggests which column holds which field. Harvest splits the name in two; that is handled in `toRows`. */
export function guessMapping(header: string[]): ImportMapping {
  const h = header.map(norm);
  const m: ImportMapping = {};
  const used = new Set<number>();
  for (const f of Object.keys(ALIASES) as ImportField[]) {
    for (const alias of ALIASES[f]) {
      const i = h.findIndex((x, k) => !used.has(k) && x === alias);
      if (i >= 0) { m[f] = i; used.add(i); break; }
    }
  }
  // «Start» alone is a time in Toggl but a date elsewhere; only keep it as time when there is a separate date.
  if (m.start !== undefined && m.date === undefined) { m.date = m.start; delete m.start; }
  return m;
}

/** 31.12.2025, 31.12.25, 2025-12-31, 12/31/2025 (US, as Toggl and Harvest write it) or an Excel serial number. */
export function parseDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})\b/);
  if (m) return iso(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[2]!, +m[1]!);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) return iso(+m[3]!, +m[1]!, +m[2]!);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function iso(y: number, mo: number, d: number) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null;
  return date.toISOString().slice(0, 10);
}

/** 1.5, 1,5, 1:30, 01:30:00 or 90 min, in hours. */
export function parseHours(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) return +m[1]! + +m[2]! / 60 + (m[3] ? +m[3] / 3600 : 0);
  m = s.match(/^(\d+(?:[.,]\d+)?)\s*(h|std|min|m)?$/);
  if (m) {
    const n = Number(m[1]!.replace(",", "."));
    return m[2] === "min" || m[2] === "m" ? n / 60 : n;
  }
  return null;
}

/** 08:30, 8:30 or 8:30:00 AM → "08:30". */
export function parseClock(v: string): string | null {
  const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1]!;
  if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12;
  if (m[3]?.toLowerCase() === "am" && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

const truthy = (v: string) => !["nein", "no", "false", "0", "n", "nicht verrechenbar", "nicht abrechenbar"].includes(v.trim().toLowerCase());

/** Turns the data rows into bookings; lines that cannot be read are listed with the reason. */
export function toRows(header: string[], data: string[][], mapping: ImportMapping, firstLine = 2): { rows: ImportRow[]; problems: ImportProblem[] } {
  const h = header.map(norm);
  const first = h.indexOf("first name");
  const last = h.indexOf("last name");
  const rows: ImportRow[] = [];
  const problems: ImportProblem[] = [];
  const get = (r: string[], f: ImportField) => (mapping[f] === undefined ? "" : (r[mapping[f]!] ?? "").trim());
  data.forEach((r, k) => {
    const line = k + firstLine;
    const date = parseDate(get(r, "date"));
    const person = get(r, "person") || (first >= 0 ? `${r[first] ?? ""} ${last >= 0 ? r[last] ?? "" : ""}`.trim() : "") || get(r, "email");
    const start = parseClock(get(r, "start"));
    const end = parseClock(get(r, "end"));
    let hours = parseHours(get(r, "hours"));
    if (hours === null && start && end) {
      const diff = (Number(end.slice(0, 2)) * 60 + Number(end.slice(3))) - (Number(start.slice(0, 2)) * 60 + Number(start.slice(3)));
      hours = (diff < 0 ? diff + 1440 : diff) / 60;
    }
    const customer = get(r, "customer");
    const project = get(r, "project");
    const task = get(r, "task");
    const description = get(r, "description");
    if (!date) return problems.push({ line, message: `Datum «${get(r, "date")}» nicht lesbar` });
    if (!person) return problems.push({ line, message: "Person fehlt" });
    if (!project) return problems.push({ line, message: "Projekt fehlt" });
    if (hours === null || !(hours > 0)) return problems.push({ line, message: `Dauer «${get(r, "hours")}» nicht lesbar` });
    if (hours > 24) return problems.push({ line, message: "Mehr als 24 Stunden an einem Tag" });
    rows.push({
      line,
      date,
      person,
      email: get(r, "email") || undefined,
      customer: customer || "Ohne Kunde",
      project,
      task: task || "Allgemein",
      reason: (description || task || project).slice(0, 1000),
      hours: Math.round(hours * 100) / 100,
      billable: mapping.billable === undefined ? true : truthy(get(r, "billable")),
      ...(start ? { startTime: start } : {}),
    });
  });
  return { rows, problems };
}

/** What an import would create: customers, projects and tasks that do not exist yet, and the people in the file. */
export function importPlan(rows: ImportRow[], existing: { customers: { name: string }[]; projects: { name: string; customer: string }[] }) {
  const key = (s: string) => s.trim().toLowerCase();
  const known = new Set(existing.customers.map((c) => key(c.name)));
  const knownProjects = new Set(existing.projects.map((p) => `${key(p.customer)}|${key(p.name)}`));
  const customers = new Map<string, number>();
  const projects = new Map<string, { customer: string; project: string; hours: number }>();
  const people = new Map<string, { name: string; email?: string; hours: number }>();
  let hours = 0;
  let from = "";
  let to = "";
  for (const r of rows) {
    hours += r.hours;
    if (!from || r.date < from) from = r.date;
    if (!to || r.date > to) to = r.date;
    if (!known.has(key(r.customer))) customers.set(r.customer, (customers.get(r.customer) ?? 0) + r.hours);
    const pk = `${key(r.customer)}|${key(r.project)}`;
    if (!knownProjects.has(pk)) {
      const p = projects.get(pk) ?? { customer: r.customer, project: r.project, hours: 0 };
      p.hours += r.hours;
      projects.set(pk, p);
    }
    const who = key(r.email || r.person);
    const p = people.get(who) ?? { name: r.person, email: r.email, hours: 0 };
    p.hours += r.hours;
    people.set(who, p);
  }
  return {
    entries: rows.length,
    hours: Math.round(hours * 100) / 100,
    from,
    to,
    newCustomers: [...customers.keys()],
    newProjects: [...projects.values()],
    people: [...people.entries()].map(([key, p]) => ({ key, ...p, hours: Math.round(p.hours * 100) / 100 })),
  };
}

/** The key that links a line of the file to a person (e-mail if present, else the name). */
export const personKey = (r: Pick<ImportRow, "person" | "email">) => (r.email || r.person).trim().toLowerCase();
