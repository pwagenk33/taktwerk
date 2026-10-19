// Core domain model. Money is in CHF, durations in hours, months as "YYYY-MM".

/** auditor = Treuhand / Revision: sees everything of the organization, changes nothing. */
export type Role = "admin" | "consultant" | "employee" | "auditor" | "customer";

export interface Employee {
  id: string;
  name: string;
  initials: string;
  role: Role;
  teamId: string;
  /** Internal cost per hour in CHF (salary incl. social costs / productive hours); leads only. Falls back to OrgRates.costRate. */
  costRate?: number;
  /** Employment level in percent (Pensum). Default 100. */
  workload?: number;
  /** Vacation days per calendar year for this person (already for their Pensum). Default 25. */
  vacationDays?: number;
  /** First day counted for target hours and overtime (YYYY-MM-DD). Default: 1 January of the current year. */
  trackingStart?: string;
  /** Overtime hours carried over into `trackingStart`. */
  overtimeCarry?: number;
  /** Vacation days carried over into the year of `trackingStart`. */
  vacationCarry?: number;
}

export interface Team {
  id: string;
  name: string;
  /** Team lead: approves absences and month closings of the members. */
  leadUserId?: string;
}

/** Hourly rate valid from a date; time entries snapshot the rate at booking time. */
export interface RatePeriod {
  validFrom: string; // YYYY-MM-DD
  hourlyRate: number;
}

export interface PostalAddress {
  name: string;
  street: string;
  zip: string;
  city: string;
  /** ISO 3166-1 alpha-2, e.g. CH. */
  country: string;
}

export type Currency = "CHF" | "EUR" | "USD";
export const CURRENCIES: Currency[] = ["CHF", "EUR", "USD"];

/** Exchange rates as CHF per one unit of foreign currency, e.g. { EUR: 0.94, USD: 0.80 }. */
export interface FxRates {
  rates: Partial<Record<Currency, number>>;
  /** Date of the quotes (YYYY-MM-DD). */
  asOf: string;
  source?: string;
}

export type ProjectKind = "tm" | "fixed" | "retainer";
export const PROJECT_KINDS: { id: ProjectKind; label: string; hint: string }[] = [
  { id: "tm", label: "Zeit und Material", hint: "Jede Stunde wird zum Kundensatz verrechnet, das Budget ist die Obergrenze." },
  { id: "fixed", label: "Fixpreis", hint: "Der Kunde zahlt den Festpreis, Mehraufwand geht zulasten der Marge." },
  { id: "retainer", label: "Retainer", hint: "Monatliches Stundenkontingent, verrechnet wird der Monatsbetrag." },
];

export interface Customer {
  id: string;
  name: string;
  rates: RatePeriod[];
  /** Currency of rates, budgets and invoices. Default CHF. */
  currency?: Currency;
  /** Postal address printed on invoices. */
  address?: PostalAddress;
}

export interface Project {
  id: string;
  customerId: string;
  name: string;
  budget: number; // in the customer's currency, may exceed the sum of sub-project budgets (reserve)
  jiraProjectKey?: string;
  /** Project lead: sees budget and bookings of this project and plans it, without being a consultant. */
  leadUserId?: string;
  /** Contract type. Default «Zeit und Material». */
  kind?: ProjectKind;
  /** Retainer: hours included per month. */
  retainerHours?: number;
}

export interface SubProject {
  id: string;
  projectId: string;
  name: string;
  budget: number; // CHF
  jiraEpicKey?: string;
}

export interface TimeEntry {
  id: string;
  employeeId: string;
  subProjectId: string;
  date: string; // YYYY-MM-DD
  hours: number;
  reason: string;
  billable: boolean;
  hourlyRate: number; // snapshot of the customer rate on `date`
  jiraIssueKey?: string;
  /** Start of the booking as HH:MM, if the person placed it in the calendar. */
  startTime?: string;
  /**
   * Monthly total of older bookings (one per person, sub-project, issue, rate and billable flag), dated on the 1st.
   * Sums stay exact; the single bookings of these months are not loaded.
   */
  summary?: boolean;
}

export type ExpenseCategory = "Reise" | "Kilometer" | "Unterkunft" | "Verpflegung" | "Material" | "Lizenzen" | "Sonstiges";
export type ExpenseStatus = "requested" | "approved" | "rejected";
export const EXPENSE_CATEGORIES = ["Reise", "Kilometer", "Unterkunft", "Verpflegung", "Material", "Lizenzen", "Sonstiges"] as const satisfies readonly ExpenseCategory[];
export const DEFAULT_RATES = { kmRate: 0.7, vatRate: 8.1 } as const;

/** Swiss VAT rates (since 2024): standard, reduced, accommodation, none. */
export const VAT_RATES = [8.1, 2.6, 3.8, 0] as const;

export interface Expense {
  id: string;
  employeeId: string;
  subProjectId: string;
  date: string;
  amount: number; // CHF, gross (incl. VAT)
  category: ExpenseCategory;
  reason: string;
  billable: boolean;
  /** Missing = approved (expenses recorded before approvals existed). Only approved expenses count. */
  status?: ExpenseStatus;
  /** VAT rate in percent contained in `amount`. */
  vatRate?: number;
  /** Kilometres for category «Kilometer»; amount = km × rate of the organization. */
  km?: number;
  /** Uploaded receipt, if any. */
  receipt?: { name: string; mime: string };
}

export type JiraStatus = "To Do" | "In Progress" | "Done";

/** Mirror of a JIRA issue, synced via the JIRA REST API. */
export interface JiraIssue {
  key: string;
  summary: string;
  subProjectId: string; // mapped through the epic link
  storyPoints: number;
  status: JiraStatus;
  resolvedAt?: string; // YYYY-MM-DD, set when status = Done
}

export type AbsenceType = "Ferien" | "Krankheit" | "Unfall" | "Militär/Zivildienst" | "Weiterbildung" | "Kompensation" | "Sonstiges";
export type AbsenceStatus = "requested" | "approved" | "rejected";

/** Absence over one or more days; `halfDay` applies to every day of the range. */
export interface Absence {
  id: string;
  employeeId: string;
  type: AbsenceType;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  note?: string;
  status: AbsenceStatus;
}

/** Public holiday; `fraction` 0.5 for half days (e.g. 24 December afternoon). */
export interface Holiday {
  date: string;
  name: string;
  fraction: number;
}

/** Organization-wide settings that influence calculations in the browser. */
export interface OrgRates {
  /** CHF per kilometre for category «Kilometer». Default 0.70. */
  kmRate: number;
  /** VAT rate in percent on invoices. Default 8.1. */
  vatRate: number;
  /** Default internal cost per hour in CHF for people without an own cost rate. */
  costRate?: number;
}

export interface WorkModel {
  /** Target hours per week at 100 %, spread over Monday to Friday. */
  weeklyHours: number;
  holidays: Holiday[];
  /** How working time is recorded: hours per day (default) or come/go with breaks. */
  timeModel?: "simplified" | "full";
}

export interface Dataset {
  teams: Team[];
  employees: Employee[];
  customers: Customer[];
  projects: Project[];
  subProjects: SubProject[];
  timeEntries: TimeEntry[];
  expenses: Expense[];
  issues: JiraIssue[];
  /** Absences visible to the viewer (employees: own only). */
  absences?: Absence[];
  workModel?: WorkModel;
  /** Bookings before this date are loaded as monthly totals (see TimeEntry.summary). */
  detailFrom?: string;
  /** Come/go periods (time model «full»). */
  workPeriods?: import("./presence").WorkPeriod[];
  rates?: OrgRates;
  /** Exchange rates for customers in EUR or USD. */
  fx?: FxRates;
  /** Resource planning: hours a person is reserved for a project in an ISO week (leads; employees see their own). */
  allocations?: Allocation[];
  today: string;
}

/** A planned reservation of a person's time for a project in one ISO week (YYYY-Www). */
export interface Allocation {
  id: string;
  employeeId: string;
  projectId: string;
  week: string;
  hours: number;
  note?: string;
}

export type VelocityMethod = "rolling" | "ewma";

export interface VelocitySettings {
  method: VelocityMethod;
  /** Months in the rolling window (rolling) or effective span (ewma). */
  window: number;
}
