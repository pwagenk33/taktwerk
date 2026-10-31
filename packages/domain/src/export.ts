import { tr } from "./i18n";

/** CSV in the dialect Excel (de-CH) opens directly: semicolon, UTF-8 BOM, quotes doubled. */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    let s = typeof v === "object" ? JSON.stringify(v) : String(v);
    // Texts typed by people (e.g. "=HYPERLINK(…)") must not run as a formula when the file is opened in Excel.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[cols.join(";"), ...rows.map((r) => cols.map((c) => cell(r[c])).join(";"))].join("\r\n")}\r\n`;
}

export const EXPORT_ENTITIES = [
  { id: "time-entries", label: tr("Zeitbuchungen") },
  { id: "expenses", label: tr("Spesen") },
  { id: "absences", label: tr("Absenzen") },
  { id: "customers", label: tr("Kunden") },
  { id: "projects", label: tr("Projekte und Subprojekte") },
  { id: "employees", label: tr("Mitarbeitende") },
] as const;
export type ExportEntity = (typeof EXPORT_ENTITIES)[number]["id"];

/** Flat rows with readable names for one entity of the dataset, optionally limited to a date range. */
export function exportRows(data: import("./types").Dataset, entity: ExportEntity, from?: string, to?: string): Record<string, unknown>[] {
  const sub = new Map(data.subProjects.map((s) => [s.id, s]));
  const proj = new Map(data.projects.map((p) => [p.id, p]));
  const cust = new Map(data.customers.map((c) => [c.id, c]));
  const emp = new Map(data.employees.map((e) => [e.id, e]));
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const ctx = (subProjectId: string) => {
    const s = sub.get(subProjectId);
    const p = s && proj.get(s.projectId);
    const c = p && cust.get(p.customerId);
    return { kunde: c?.name ?? "", projekt: p?.name ?? "", subprojekt: s?.name ?? "", waehrung: c?.currency ?? "CHF" };
  };
  switch (entity) {
    case "time-entries":
      return data.timeEntries.filter((e) => inRange(e.date)).sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({
        datum: e.date, start: e.startTime ?? "", person: emp.get(e.employeeId)?.name ?? e.employeeId, ...ctx(e.subProjectId), stunden: e.hours, grund: e.reason, verrechenbar: e.billable ? "ja" : "nein", stundensatz: e.hourlyRate, betrag: e.billable ? Math.round(e.hours * e.hourlyRate * 100) / 100 : 0, jira: e.jiraIssueKey ?? "", id: e.id,
      }));
    case "expenses":
      return data.expenses.filter((x) => inRange(x.date)).sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({
        datum: x.date, person: emp.get(x.employeeId)?.name ?? x.employeeId, ...ctx(x.subProjectId), kategorie: x.category, betrag_chf: x.amount, mwst_prozent: x.vatRate ?? "", km: x.km ?? "", grund: x.reason, verrechenbar: x.billable ? "ja" : "nein", status: x.status ?? "approved", beleg: x.receipt?.name ?? "", id: x.id,
      }));
    case "absences":
      return (data.absences ?? []).filter((a) => inRange(a.startDate) || inRange(a.endDate)).map((a) => ({
        person: emp.get(a.employeeId)?.name ?? a.employeeId, art: a.type, von: a.startDate, bis: a.endDate, halbe_tage: a.halfDay ? "ja" : "nein", status: a.status, notiz: a.note ?? "", id: a.id,
      }));
    case "customers":
      return data.customers.map((c) => ({ kunde: c.name, waehrung: c.currency ?? "CHF", stundensatz: [...c.rates].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1)?.hourlyRate ?? "", saetze: c.rates.map((r) => `${r.validFrom}: ${r.hourlyRate}`).join(" | "), projekte: data.projects.filter((p) => p.customerId === c.id).length, id: c.id }));
    case "projects":
      return data.subProjects.map((s) => {
        const p = proj.get(s.projectId);
        const c = p && cust.get(p.customerId);
        return { kunde: c?.name ?? "", projekt: p?.name ?? "", projektart: p?.kind ?? "tm", projektbudget: p?.budget ?? "", kontingent_h_monat: p?.retainerHours ?? "", subprojekt: s.name, subprojektbudget: s.budget, jira_projekt: p?.jiraProjectKey ?? "", jira_epic: s.jiraEpicKey ?? "", waehrung: c?.currency ?? "CHF", projekt_id: p?.id ?? "", subprojekt_id: s.id };
      });
    case "employees":
      return data.employees.map((e) => ({ name: e.name, rolle: e.role, pensum: e.workload ?? 100, ferientage: e.vacationDays ?? "", kostensatz: e.costRate ?? "", erfassung_ab: e.trackingStart ?? "", id: e.id }));
  }
}
