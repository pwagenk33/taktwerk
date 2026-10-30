// Payroll export: per person and month the figures a payroll system needs (hours, overtime, absences,
// expenses to reimburse), as rows with the company's own wage type numbers. The file is a plain
// CSV/Excel import; it is not a certified Swissdec (ELM) transmission.
import { tr } from "./i18n";
import type { AbsenceType, Dataset } from "./types";
import { absenceDays, daysBetween, workBalance } from "./worktime";

export const PAYROLL_ITEMS = [
  { id: "hours", label: tr("Geleistete Stunden"), unit: "h", code: "1000" },
  { id: "target", label: tr("Sollstunden"), unit: "h", code: "1001" },
  { id: "overtime", label: tr("Überzeit im Monat"), unit: "h", code: "1100" },
  { id: "overtimeBalance", label: tr("Überzeit-Saldo Ende Monat"), unit: "h", code: "1101" },
  { id: "vacation", label: tr("Ferien"), unit: "d", code: "2000" },
  { id: "sick", label: tr("Krankheit"), unit: "d", code: "2100" },
  { id: "accident", label: tr("Unfall"), unit: "d", code: "2200" },
  { id: "military", label: tr("Militär/Zivildienst"), unit: "d", code: "2300" },
  { id: "training", label: tr("Weiterbildung"), unit: "d", code: "2400" },
  { id: "compensation", label: tr("Kompensation"), unit: "d", code: "2500" },
  { id: "otherAbsence", label: tr("Sonstige Absenz"), unit: "d", code: "2900" },
  { id: "expenses", label: tr("Spesen (ohne Kilometer)"), unit: "CHF", code: "6000" },
  { id: "mileage", label: tr("Kilometerentschädigung"), unit: "CHF", code: "6010" },
] as const;
export type PayrollItem = (typeof PAYROLL_ITEMS)[number]["id"];
export type PayrollCodes = Partial<Record<PayrollItem, string>>;

const ABSENCE_ITEM: Record<AbsenceType, PayrollItem> = {
  Ferien: "vacation",
  Krankheit: "sick",
  Unfall: "accident",
  "Militär/Zivildienst": "military",
  Weiterbildung: "training",
  Kompensation: "compensation",
  Sonstiges: "otherAbsence",
};

export interface PayrollRow {
  personnelNumber: string;
  name: string;
  month: string;
  item: PayrollItem;
  code: string;
  label: string;
  quantity: number;
  unit: "h" | "d" | "CHF";
  /** Only for CHF items: the amount to pay out. */
  amount: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Rows for `month` (YYYY-MM), one per person and item with a value; persons without personnel number keep
 * their name so nothing gets lost. Only approved absences and approved expenses count.
 */
export function payrollRows(data: Dataset, month: string, codes: PayrollCodes = {}, employeeIds?: string[]): PayrollRow[] {
  const def = new Map(PAYROLL_ITEMS.map((i) => [i.id as PayrollItem, i]));
  const first = `${month}-01`;
  const last = daysBetween(first, `${month}-31`).filter((d) => d.startsWith(month)).at(-1)!;
  const rows: PayrollRow[] = [];
  for (const e of data.employees) {
    if (employeeIds && !employeeIds.includes(e.id)) continue;
    const values = new Map<PayrollItem, number>();
    const add = (item: PayrollItem, v: number) => v && values.set(item, (values.get(item) ?? 0) + v);

    const until = last < data.today ? last : data.today;
    if (first <= until) {
      const m = workBalance(data, e.id, until).months.find((x) => x.month === month);
      if (m) {
        add("hours", m.worked);
        add("target", m.target - m.absence);
        add("overtime", m.balance);
        values.set("overtimeBalance", m.cumulative);
      }
    }
    for (const a of data.absences ?? []) {
      if (a.employeeId !== e.id || a.status !== "approved" || a.endDate < first || a.startDate > last) continue;
      const from = a.startDate < first ? first : a.startDate;
      const to = a.endDate > last ? last : a.endDate;
      add(ABSENCE_ITEM[a.type], absenceDays(data, { startDate: from, endDate: to, halfDay: a.halfDay }));
    }
    for (const x of data.expenses) {
      if (x.employeeId !== e.id || !x.date.startsWith(month) || (x.status ?? "approved") !== "approved") continue;
      add(x.category === "Kilometer" ? "mileage" : "expenses", x.amount);
    }
    for (const i of PAYROLL_ITEMS) {
      const v = values.get(i.id);
      if (v === undefined || (Math.abs(v) < 0.005 && i.id !== "overtimeBalance")) continue;
      const d = def.get(i.id)!;
      rows.push({
        personnelNumber: e.personnelNumber ?? "",
        name: e.name,
        month,
        item: i.id,
        code: codes[i.id]?.trim() || d.code,
        label: tr(d.label),
        quantity: r2(v),
        unit: d.unit,
        amount: d.unit === "CHF" ? r2(v) : null,
      });
    }
  }
  return rows;
}

/** Flat rows for CSV/Excel with German column names that payroll tools map easily. */
export const payrollTable = (rows: PayrollRow[]) =>
  rows.map((r) => ({ personalnummer: r.personnelNumber, name: r.name, periode: r.month, lohnart: r.code, bezeichnung: r.label, menge: r.quantity, einheit: r.unit === "d" ? tr("Tage") : r.unit, betrag: r.amount ?? "" }));
